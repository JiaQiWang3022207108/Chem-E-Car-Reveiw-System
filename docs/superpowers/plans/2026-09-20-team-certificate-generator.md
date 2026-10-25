# Team Certificate Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有赛事资料中心新增团队获奖证书制作工作区，让已登录操作者保存一次赛事模板，并在浏览器本地生成一校一张的 A4 横版 PDF。

**Architecture:** 服务端仅用 D1 保存赛事名称与落款文字、用 R2 保存当前公章，并从既有 EDP 审核设置读取竞赛年份；学校、奖项和人员名单只存在于浏览器内存。前端用一个独立证书工作区调用同一套 Canvas 排版器完成预览和 300 DPI 输出，再把画布 JPEG 封装为单页 A4 横版 PDF。

**Tech Stack:** React 19、TypeScript、Canvas 2D、Cloudflare Worker、D1、R2、Node test、Miniflare、pdfjs-dist、Vinext/Sites。

**Spec:** `docs/superpowers/specs/2026-09-20-team-certificate-generator-design.md`

## Global Constraints

- 第一版只生成团队奖项证书，每所学校或参赛队一张，不生成个人证书。
- 赛事名称、落款文字和公章首次手动保存，后续自动复用；竞赛年份只读使用 `edp_review_settings.competition_year`。
- 学校、奖项、指导教师、参赛队员、颁发月份和生成后的 PDF 不得写入 D1、R2、日志、浏览器持久存储或网络请求。
- 指导教师最多 5 人，参赛队员最多 15 人；任何姓名不得静默省略或裁切。
- PDF 必须为单页 A4 横向，300 DPI 画布约为 3508 × 2480 像素，日期只显示到月份。
- 公章只接受 PNG/JPEG，最大 5 MB，最短边至少 300 像素；替换失败时继续使用旧公章。
- 不增加证书历史、批量导入、证书编号、验真二维码、邮件发送、hash、冻结 contract、baseline 或额外 gate。
- 不添加新的 PDF 运行时依赖；使用现有浏览器 Canvas 和项目内的轻量 PDF 封装器。
- 不修改现有六个工作区的业务规则，不删除认证、同源校验、文件头校验或其他安全措施。
- 本计划只完成本地/ChatGPT 预览与验证，不执行公开发布。

## File Structure

- Create `worker/certificate-template-api.ts`: 证书模板读取、文字保存、公章上传/下载、图片结构校验和 R2 切换逻辑。
- Create `app/certificate-pdf.ts`: 姓名解析、字段校验、布局计算、Canvas 绘制、文件名清理和 PDF 字节封装。
- Create `app/certificate-workspace.tsx`: 模板设置、单张证书表单、实时预览、下载与重试交互。
- Create `drizzle/0019_certificate_templates.sql`: D1 证书模板表迁移。
- Modify `db/schema.ts`: 增加 `certificateTemplates` Drizzle 表定义。
- Modify `drizzle/meta/_journal.json`: 登记 `0019_certificate_templates`。
- Modify `worker/index.ts`: 在兜底建表中加入证书模板表并接入受认证 API 路由。
- Modify `app/collector-dashboard.tsx`: 工作区类型、状态文案、导航和证书工作区渲染。
- Modify `app/globals.css`: 证书设置、表单、画布预览和响应式样式。
- Modify `tests/rendered-html.test.mjs`: 模板 API、隐私边界、姓名解析、布局、PDF 结构和七工作区回归测试。
- Modify `README.md`: 把六工作区说明更新为七工作区，并记录模板复用与本地生成边界。

---

### Task 1: Certificate Template Persistence and Authenticated Stamp API

**Files:**
- Create: `worker/certificate-template-api.ts`
- Create: `drizzle/0019_certificate_templates.sql`
- Modify: `db/schema.ts`
- Modify: `drizzle/meta/_journal.json`
- Modify: `worker/index.ts:1-85,510-760,3709-3731`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: 已通过 `worker/index.ts` 完成的共享会话认证、同源校验、`D1Database` 和 `R2Bucket`。
- Produces: `handleCertificateTemplateApi(request, env, userId, url): Promise<Response | null>`；前端可调用 `GET/PUT /api/certificate-template`、`POST/GET /api/certificate-template/stamp`。

- [ ] **Step 1: Write failing migration and API tests**

在 `tests/rendered-html.test.mjs` 增加实际 PNG 构造器和 API 生命周期测试。PNG 构造器使用 `node:zlib` 生成真实的 300 × 300 RGBA 图片，避免只伪造文件头：

```js
import { deflateSync } from "node:zlib";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])));
  return Buffer.concat([length, typeBytes, payload, checksum]);
}

function testStampPng(width = 300, height = 300) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height, 0xff);
  for (let row = 0; row < height; row += 1) rows[row * (width * 4 + 1)] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}
```

测试必须覆盖：未登录返回 401；空模板返回竞赛年份但 `complete=false`；文字设置可保存并保留换行；多余的学校和姓名字段不会落库；伪图片和 299 像素公章被拒绝；有效公章可上传、读取且响应为 `private, no-store`；第二次上传后 D1 指向新对象且旧 R2 对象被删除。

```js
test("certificate template API persists only reusable fields and safely replaces the stamp", async () => {
  const [worker, cookie] = await Promise.all([loadWorker(), authenticatedCookie()]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "certificate-template-test" },
  });
  try {
    const DB = await miniflare.getD1Database("DB");
    await DB.prepare(`CREATE TABLE edp_review_settings (
      user_id TEXT PRIMARY KEY NOT NULL, competition_year TEXT NOT NULL DEFAULT '',
      safety_reviewer_name TEXT NOT NULL DEFAULT '', safety_reviewer_email TEXT NOT NULL DEFAULT '',
      expert_member_name TEXT NOT NULL DEFAULT '', expert_member_email TEXT NOT NULL DEFAULT '',
      template_version TEXT NOT NULL DEFAULT 'v1', active_rule_document_id TEXT,
      active_rule_version TEXT, updated_at TEXT NOT NULL
    )`).run();
    await DB.prepare("INSERT INTO edp_review_settings (user_id, competition_year, updated_at) VALUES (?, ?, ?)")
      .bind("shared-browser-workspace", "2026", "2026-09-20T00:00:00.000Z").run();
    const files = new FakeR2();
    const env = await makeAuthEnv({ DB, FILES: files });

    assert.equal((await callApi(worker, env, "/api/certificate-template")).status, 401);
    const empty = await callApi(worker, env, "/api/certificate-template", { cookie });
    const emptyPayload = await empty.json();
    assert.equal(emptyPayload.competitionYear, "2026");
    assert.equal(emptyPayload.template.complete, false);

    const saved = await callApi(worker, env, "/api/certificate-template", {
      method: "PUT", origin: AUTH_ORIGIN, cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName: "中国大学生Chem-E-Car®竞赛暨AIChE Chem-E-Car®友谊赛",
        issuerText: "竞赛委员会\n中国化工学会",
        schoolName: "不得保存的学校",
        members: ["不得保存的姓名"],
      }),
    });
    assert.equal(saved.status, 200);
    const row = await DB.prepare("SELECT * FROM certificate_templates WHERE user_id = ?")
      .bind("shared-browser-workspace").first();
    assert.equal(row.event_name, "中国大学生Chem-E-Car®竞赛暨AIChE Chem-E-Car®友谊赛");
    assert.equal(row.issuer_text, "竞赛委员会\n中国化工学会");

    const uploadForm = new FormData();
    uploadForm.set("stamp", new File([testStampPng()], "official-stamp.png", { type: "image/png" }));
    const uploaded = await callApi(worker, env, "/api/certificate-template/stamp", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: uploadForm,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    const download = await callApi(worker, env, "/api/certificate-template/stamp", { cookie });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("Cache-Control"), "private, no-store");
    assert.equal(download.headers.get("Content-Type"), "image/png");
  } finally {
    await miniflare.dispose();
  }
});
```

- [ ] **Step 2: Run the certificate API test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="certificate template API" tests/rendered-html.test.mjs
```

Expected: FAIL because `/api/certificate-template` does not exist and `certificate_templates` is not created.

- [ ] **Step 3: Add the Drizzle table and migration**

Add this schema to `db/schema.ts` and the equivalent SQL to `drizzle/0019_certificate_templates.sql`:

```ts
export const certificateTemplates = sqliteTable("certificate_templates", {
  userId: text("user_id").primaryKey(),
  eventName: text("event_name").notNull().default(""),
  issuerText: text("issuer_text").notNull().default(""),
  stampR2Key: text("stamp_r2_key"),
  stampFilename: text("stamp_filename"),
  stampContentType: text("stamp_content_type"),
  stampSize: integer("stamp_size"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("chk_certificate_templates_stamp_size", sql`${table.stampSize} IS NULL OR (${table.stampSize} > 0 AND ${table.stampSize} <= 5242880)`),
]);
```

```sql
CREATE TABLE `certificate_templates` (
  `user_id` text PRIMARY KEY NOT NULL,
  `event_name` text DEFAULT '' NOT NULL,
  `issuer_text` text DEFAULT '' NOT NULL,
  `stamp_r2_key` text,
  `stamp_filename` text,
  `stamp_content_type` text,
  `stamp_size` integer,
  `updated_at` text NOT NULL,
  CONSTRAINT `chk_certificate_templates_stamp_size`
    CHECK(`stamp_size` IS NULL OR (`stamp_size` > 0 AND `stamp_size` <= 5242880))
);
```

在 `drizzle/meta/_journal.json` 追加以下条目；在 `worker/index.ts` 的 `ensureSchema()` 批处理中加入同一建表 SQL，保证本地旧数据库也能安全升级：

```json
{
  "idx": 19,
  "version": "6",
  "when": 1789862400000,
  "tag": "0019_certificate_templates",
  "breakpoints": true
}
```

- [ ] **Step 4: Implement the isolated template API module**

在 `worker/certificate-template-api.ts` 定义稳定接口：

```ts
export interface CertificateTemplateApiEnv {
  DB: D1Database;
  FILES: R2Bucket;
}

export interface CertificateTemplatePayload {
  eventName: string;
  issuerText: string;
  stamp: {
    configured: boolean;
    filename: string | null;
    contentType: "image/png" | "image/jpeg" | null;
    url: string | null;
  };
  complete: boolean;
  updatedAt: string | null;
}

export interface CertificateTemplateResponse {
  ok: true;
  competitionYear: string;
  template: CertificateTemplatePayload;
}

export async function handleCertificateTemplateApi(
  request: Request,
  env: CertificateTemplateApiEnv,
  userId: string,
  url: URL,
): Promise<Response | null>;
```

模块内部实现以下边界：

```ts
const MAX_STAMP_BYTES = 5 * 1024 * 1024;
const MIN_STAMP_EDGE = 300;
const MAX_EVENT_NAME_LENGTH = 200;
const MAX_ISSUER_TEXT_LENGTH = 600;

function stampKey(userId: string, contentType: "image/png" | "image/jpeg") {
  const extension = contentType === "image/png" ? "png" : "jpg";
  const storageUser = userId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
  return `users/${storageUser}/certificate-template/stamp-${crypto.randomUUID()}.${extension}`;
}
```

- PNG 校验签名、IHDR、IDAT、IEND、宽高和 chunk 边界；JPEG 校验 SOI、SOF 宽高和 EOI。
- `PUT /api/certificate-template` 只读取并保存 `eventName` 与 `issuerText`，忽略请求中的其他键。
- `GET /api/certificate-template` 同时查询 `edp_review_settings.competition_year`，但不复制或修改该年份。
- `POST /api/certificate-template/stamp` 先写新 R2 键，再用 UPSERT 切换 D1 指针；D1 失败时删除新对象，成功后再删除旧对象。
- `GET /api/certificate-template/stamp` 返回当前对象，并设置 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff` 和正确 `Content-Length`。
- 模块像 `edp-review-api.ts` 一样捕获自己的 `CertificateTemplateApiError` 并返回统一 JSON，不把文件字节或模板全文写入日志。

- [ ] **Step 5: Wire the API after authentication**

在 `worker/index.ts` 导入并接入路由：

```ts
import { handleCertificateTemplateApi } from "./certificate-template-api";
```

在 `requireBusinessSession()` 和 `ensureSchema()` 成功后、普通业务路由之前加入：

```ts
const certificateTemplateResponse = await handleCertificateTemplateApi(request, env, userId, url);
if (certificateTemplateResponse) return certificateTemplateResponse;
```

这样未登录请求仍由现有认证层拦截，写请求仍先经过 `requireSameOrigin()`。

- [ ] **Step 6: Run focused API and schema tests**

Run:

```powershell
node --test --test-name-pattern="certificate template API|certificate_templates" tests/rendered-html.test.mjs
```

Expected: PASS；伪图片和 299 像素图片返回 4xx，有效图片保存后可下载，替换后旧对象消失。

- [ ] **Step 7: Commit the backend slice**

```powershell
git add db/schema.ts drizzle/0019_certificate_templates.sql drizzle/meta/_journal.json worker/certificate-template-api.ts worker/index.ts tests/rendered-html.test.mjs
git commit -m "feat: add certificate template storage"
```

---

### Task 2: Deterministic Certificate Layout and Browser PDF Core

**Files:**
- Create: `app/certificate-pdf.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: 无服务端依赖；只接收普通字符串、已解码 `CanvasImageSource` 和 Canvas 2D 上下文。
- Produces: `parseCertificateNames`、`prepareCertificateData`、`renderCertificateCanvas`、`certificateFilename`、`buildSinglePageJpegPdf`、`canvasToCertificatePdf`。

- [ ] **Step 1: Add a TypeScript module loader and failing pure tests**

沿用测试文件中现有 `ts.transpileModule` 模式：

```js
let certificatePdfPromise;

function loadCertificatePdf() {
  if (!certificatePdfPromise) {
    certificatePdfPromise = readFile(new URL("../app/certificate-pdf.ts", import.meta.url), "utf8").then((source) => {
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: "certificate-pdf.ts",
      }).outputText;
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return certificatePdfPromise;
}
```

加入以下测试，明确姓名解析、重复提醒、人数上限、月份、文件名、布局完整性和 PDF 页面尺寸：

```js
test("certificate PDF core preserves every allowed name and emits one A4 landscape page", async () => {
  const {
    parseCertificateNames,
    prepareCertificateData,
    createCertificateLayout,
    certificateFilename,
    buildSinglePageJpegPdf,
  } = await loadCertificatePdf();

  assert.deepEqual(parseCertificateNames("张三、李四\n王五; 赵六，钱七"), ["张三", "李四", "王五", "赵六", "钱七"]);
  const prepared = prepareCertificateData({
    competitionYear: "2026",
    eventName: "中国大学生Chem-E-Car®竞赛暨AIChE Chem-E-Car®友谊赛",
    issuerText: "竞赛委员会\n中国化工学会",
    schoolName: "天津大学",
    awardName: "性能竞赛二等奖",
    instructorsText: "教师一 教师二 教师三 教师四 教师五",
    membersText: Array.from({ length: 15 }, (_, index) => `队员${index + 1}`).join("、"),
    issueMonth: "2026-08",
  });
  assert.equal(prepared.ok, true);
  const layout = createCertificateLayout(prepared.data, (text, fontPx) => text.length * fontPx * 0.56, 3508, 2480);
  assert.equal(layout.overflowField, null);
  assert.equal(layout.runs.map(({ text }) => text).join(" ").includes("队员15"), true);
  assert.equal(certificateFilename(prepared.data), "天津大学-性能竞赛二等奖-获奖证书.pdf");

  const pdfBytes = buildSinglePageJpegPdf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 3508, 2480);
  assert.equal(new TextDecoder().decode(pdfBytes.slice(0, 8)), "%PDF-1.4");
  const pdf = await (await import("pdfjs-dist/legacy/build/pdf.mjs")).getDocument({ data: pdfBytes }).promise;
  assert.equal(pdf.numPages, 1);
  const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
  assert.ok(Math.abs(viewport.width - 841.89) < 0.1);
  assert.ok(Math.abs(viewport.height - 595.28) < 0.1);
});
```

再添加边界测试：第 6 名指导教师、第 16 名队员、非法月份和无法在最小字号内放入的超长赛事名称均返回具体字段错误；重复姓名只产生 warning，不删除姓名。

- [ ] **Step 2: Run the pure tests and verify they fail**

Run:

```powershell
node --test --test-name-pattern="certificate PDF core|certificate input limits" tests/rendered-html.test.mjs
```

Expected: FAIL because `app/certificate-pdf.ts` and its exports do not exist.

- [ ] **Step 3: Implement input normalization and stable types**

在 `app/certificate-pdf.ts` 定义：

```ts
export const CERTIFICATE_WIDTH_PX = 3508;
export const CERTIFICATE_HEIGHT_PX = 2480;
export const CERTIFICATE_PREVIEW_WIDTH_PX = 1754;
export const CERTIFICATE_PREVIEW_HEIGHT_PX = 1240;

export interface CertificateDraft {
  competitionYear: string;
  eventName: string;
  issuerText: string;
  schoolName: string;
  awardName: string;
  instructorsText: string;
  membersText: string;
  issueMonth: string;
}

export interface CertificateData extends Omit<CertificateDraft, "instructorsText" | "membersText"> {
  instructors: string[];
  members: string[];
}

export type CertificateField = "competitionYear" | "eventName" | "issuerText" | "schoolName" | "awardName" | "instructors" | "members" | "issueMonth";

export type CertificatePreparation =
  | { ok: true; data: CertificateData; warnings: string[] }
  | { ok: false; errors: Array<{ field: CertificateField; message: string }>; warnings: string[] };
```

`parseCertificateNames()` 必须按 `/[\s、，,；;]+/u` 分隔，保留顺序和重复项；`prepareCertificateData()` 校验必填项、`^20\d{2}$` 年份、`^20\d{2}-(0[1-9]|1[0-2])$` 月份及 5/15 人上限。

- [ ] **Step 4: Implement normalized layout and drawing**

让预览和正式输出共享同一组归一化坐标：

```ts
export interface CertificateTextRun {
  text: string;
  x: number;
  y: number;
  fontPx: number;
  color: string;
  align: CanvasTextAlign;
  weight: 500 | 600 | 700;
}

export interface CertificateLayout {
  runs: CertificateTextRun[];
  issuerLines: CertificateTextRun[];
  stampBox: { x: number; y: number; width: number; height: number };
  overflowField: CertificateField | null;
}

export function createCertificateLayout(
  data: CertificateData,
  measure: (text: string, fontPx: number, weight: number) => number,
  width: number,
  height: number,
): CertificateLayout;

export function renderCertificateCanvas(
  canvas: HTMLCanvasElement,
  data: CertificateData,
  stamp: CanvasImageSource,
  width?: number,
  height?: number,
): CertificateLayout;
```

实现要求：

- 先画白底、金棕色双框、重复菱形边饰和四角几何纹样；
- 标题固定为“获奖证书”，正文固定为已批准的六段顺序；
- 学校、赛事名称、奖项、教师、队员和落款分别测量、换行并逐级缩小到各自最小字号；
- 先缩小名单行距，再缩小名单字号；任何字段仍溢出时设置 `overflowField` 并停止导出；
- 公章按原始比例放入固定 `stampBox`，日期用 `YYYY年M月`；
- 所有颜色、字号下限和边距作为文件顶部常量，避免组件重复维护坐标。

- [ ] **Step 5: Implement the dependency-free PDF writer**

`buildSinglePageJpegPdf()` 用五个 PDF 对象写入一张 JPEG：Catalog、Pages、Page、Image XObject 和 Content Stream。页面框固定为 `[0 0 841.89 595.28]`，图像使用 `/DCTDecode`；所有 xref 偏移按最终 `Uint8Array` 字节长度计算，不能用 JavaScript 字符长度代替。

```ts
export function buildSinglePageJpegPdf(jpeg: Uint8Array, pixelWidth: number, pixelHeight: number): Uint8Array;

export async function canvasToCertificatePdf(canvas: HTMLCanvasElement): Promise<Blob> {
  const jpegBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器无法编码证书图像。")), "image/jpeg", 0.98);
  });
  return new Blob(
    [buildSinglePageJpegPdf(new Uint8Array(await jpegBlob.arrayBuffer()), canvas.width, canvas.height)],
    { type: "application/pdf" },
  );
}
```

`certificateFilename()` 用 `-` 替换 `/[<>:"/\\|?*\u0000-\u001F]+/gu`，压缩连续空白和连字符，并在结果为空时回退为 `团队获奖证书.pdf`。

- [ ] **Step 6: Run focused PDF tests**

Run:

```powershell
node --test --test-name-pattern="certificate PDF core|certificate input limits" tests/rendered-html.test.mjs
```

Expected: PASS；PDF 可被现有 `pdfjs-dist` 打开为一页横向 A4，15 名队员全部在布局结果中。

- [ ] **Step 7: Commit the PDF core**

```powershell
git add app/certificate-pdf.ts tests/rendered-html.test.mjs
git commit -m "feat: add browser certificate PDF engine"
```

---

### Task 3: Certificate Template Editor, Live Preview, and Local Download UI

**Files:**
- Create: `app/certificate-workspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Task 1 的模板 API；Task 2 的 `CertificateDraft`、`CertificateField`、`prepareCertificateData()`、`renderCertificateCanvas()`、`canvasToCertificatePdf()` 和 `certificateFilename()`。
- Produces: `CertificateWorkspace(): React.JSX.Element`，供控制台作为第七个工作区渲染。

- [ ] **Step 1: Add failing source and privacy-boundary tests**

```js
test("certificate workspace saves only the reusable template and generates private fields locally", async () => {
  const workspace = await readFile(new URL("../app/certificate-workspace.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const label of ["赛事名称", "落款文字", "公章图片", "学校/参赛队", "奖项名称", "指导教师", "参赛队员", "颁发月份", "生成并下载 PDF"]) {
    assert.match(workspace, new RegExp(label));
  }
  assert.match(workspace, /\/api\/certificate-template/);
  assert.match(workspace, /createImageBitmap/);
  assert.match(workspace, /renderCertificateCanvas/);
  assert.match(workspace, /canvasToCertificatePdf/);
  assert.match(workspace, /type="month"/);
  assert.doesNotMatch(workspace, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(workspace, /JSON\.stringify\([^)]*(schoolName|awardName|instructorsText|membersText)/s);
  for (const selector of ["certificate-workspace", "certificate-template-card", "certificate-form-card", "certificate-preview-card", "certificate-canvas-frame"]) {
    assert.match(css, new RegExp(`\\.${selector}`));
  }
});
```

- [ ] **Step 2: Run the workspace test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="certificate workspace" tests/rendered-html.test.mjs
```

Expected: FAIL because `app/certificate-workspace.tsx` does not exist.

- [ ] **Step 3: Build the template lifecycle**

在 `app/certificate-workspace.tsx` 使用 `"use client"`，定义服务端响应类型和本地表单状态：

```ts
import {
  canvasToCertificatePdf,
  certificateFilename,
  prepareCertificateData,
  renderCertificateCanvas,
  type CertificateField,
} from "./certificate-pdf";

type CertificateTemplate = {
  eventName: string;
  issuerText: string;
  stamp: { configured: boolean; filename: string | null; contentType: string | null; url: string | null };
  complete: boolean;
  updatedAt: string | null;
};

type CertificateTemplateResponse = {
  ok: true;
  competitionYear: string;
  template: CertificateTemplate;
};

type CertificateForm = {
  schoolName: string;
  awardName: string;
  instructorsText: string;
  membersText: string;
  issueMonth: string;
};
```

- 首次挂载以 `cache: "no-store"` 请求 `GET /api/certificate-template`，分别保存响应中的 `competitionYear` 和 `template`；
- 模板不完整时自动展开编辑卡，完整时默认折叠并提供“编辑模板”；
- 文字保存仅发送 `{ eventName, issuerText }`；
- 公章文件先检查 5 MB，再调用 `createImageBitmap(file)` 验证可解码和尺寸，最后单独用 `FormData` POST；
- 上传成功后重新读取模板和公章 URL；失败时保留原模板和本地表单；
- 所有错误显示在工作区自己的 `role="alert"` 区域，不记录人员名单。

- [ ] **Step 4: Build the local form and live preview**

表单初始月份使用本地年月，避免 UTC 跨日：

```ts
function currentLocalMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
```

组件持有 `previewCanvasRef`、`stampImageRef` 和 `lastPdfRef`。模板或表单变化时调用 `prepareCertificateData()`；数据有效且公章已加载时，用 1754 × 1240 画布调用 `renderCertificateCanvas()`。重复姓名 warning 显示为非阻塞提示；`overflowField` 映射成具体中文字段并禁用下载。

公章读取使用经过认证的同源请求，并把响应完整解码为 `ImageBitmap` 后才写入 `stampImageRef`：

```ts
async function loadStamp(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("公章图片读取失败，请重新保存模板。");
  return createImageBitmap(await response.blob());
}
```

模板更新或组件卸载时调用旧 `ImageBitmap.close()`，避免反复预览积累图像内存。

模板未完成、竞赛年份不是四位年份、字体未就绪、公章未加载或字段校验失败时，下载按钮必须禁用并解释原因。

- [ ] **Step 5: Implement full-resolution generation and retry download**

生成处理器只使用本地值：

```ts
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function generateCertificate() {
  await document.fonts.ready;
  if (!document.fonts.check('700 32px "Microsoft YaHei"', "获奖证书")) {
    throw new Error("当前浏览器未准备好中文字体，请刷新页面后重试。");
  }
  const prepared = prepareCertificateData({
    competitionYear,
    eventName: template.eventName,
    issuerText: template.issuerText,
    ...form,
  });
  if (!prepared.ok || !stampImageRef.current) return;
  const canvas = document.createElement("canvas");
  const layout = renderCertificateCanvas(canvas, prepared.data, stampImageRef.current);
  if (layout.overflowField) {
    const labels: Record<CertificateField, string> = {
      competitionYear: "竞赛年份", eventName: "赛事名称", issuerText: "落款文字",
      schoolName: "学校/参赛队", awardName: "奖项名称", instructors: "指导教师",
      members: "参赛队员", issueMonth: "颁发月份",
    };
    throw new Error(`${labels[layout.overflowField]}内容过长，无法完整放入证书安全区域。`);
  }
  const blob = await canvasToCertificatePdf(canvas);
  lastPdfRef.current = { blob, filename: certificateFilename(prepared.data) };
  downloadBlob(blob, certificateFilename(prepared.data));
}
```

若浏览器拦截第一次下载，显示“再次下载”按钮并复用 `lastPdfRef`；再次下载不得重新渲染，也不得上传 Blob。生成成功后保留表单，方便操作者核对或手动改下一校。

- [ ] **Step 6: Add responsive and print-safe visual styles**

在 `app/globals.css` 增加：

- `.certificate-workspace`：桌面两列、窄屏单列；
- `.certificate-template-card`：模板状态、编辑表单和公章缩略图；
- `.certificate-form-card`：清晰的字段分组、人数计数和 warning；
- `.certificate-preview-card`：固定白底、柔和边框和操作区；
- `.certificate-canvas-frame canvas`：保持 `aspect-ratio: 297 / 210`、最大宽度 100%、不改变内部分辨率；
- `@media (max-width: 900px)`：先表单后预览；
- `@media (max-width: 680px)`：按钮全宽、字段单列、画布可横向缩放但页面不产生横向滚动。

沿用现有 CSS 变量，不引入另一套主题，不把预览画布的视觉文字复制为 DOM 内容。

- [ ] **Step 7: Run focused UI tests and lint the new files**

Run:

```powershell
node --test --test-name-pattern="certificate workspace" tests/rendered-html.test.mjs
npx eslint app/certificate-workspace.tsx app/certificate-pdf.ts
```

Expected: PASS，且 ESLint 无错误。

- [ ] **Step 8: Commit the workspace slice**

```powershell
git add app/certificate-workspace.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add certificate creation workspace"
```

---

### Task 4: Add the Seventh Workspace Without Expanding Existing Collector Scope

**Files:**
- Modify: `app/collector-dashboard.tsx:1-5,394,1189-1295,1600-1655,3017-3299`
- Modify: `tests/rendered-html.test.mjs:1815-1832,1911-1955`

**Interfaces:**
- Consumes: Task 3 的默认导出 `CertificateWorkspace`。
- Produces: `Workspace` 新值 `certificate`、第七个导航项和证书页面渲染分支；既有 `FankeKind` 仍只包含报名表、EDP、海报和视频。

- [ ] **Step 1: Change the navigation test to require seven ordered workspaces**

```js
test("console exposes seven focused workspaces and consolidated collection help", async () => {
  const dashboard = await readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8");
  const navigation = dashboard.slice(dashboard.indexOf("<nav>"), dashboard.indexOf("</nav>"));
  const labels = ["报名表统计", "EDP 提交统计", "EDP 审核", "阿里邮箱连接", "海报收集", "视频收集", "证书制作"];
  let cursor = -1;
  for (const label of labels) {
    const next = navigation.indexOf(label);
    assert.ok(next > cursor, `${label} must follow the previous workspace`);
    cursor = next;
  }
  assert.match(dashboard, /<CertificateWorkspace\s*\/>/);
  assert.match(dashboard, /type FankeKind = Exclude<Workspace, "mail" \| "edpReview" \| "certificate">/);
});
```

- [ ] **Step 2: Run the navigation test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="seven focused workspaces" tests/rendered-html.test.mjs
```

Expected: FAIL because the navigation still has six workspaces.

- [ ] **Step 3: Integrate the workspace type, status, navigation, and render branch**

在 `app/collector-dashboard.tsx`：

```ts
import CertificateWorkspace from "./certificate-workspace";

type Workspace = "registration" | "edp" | "edpReview" | "mail" | "poster" | "video" | "certificate";
type FankeKind = Exclude<Workspace, "mail" | "edpReview" | "certificate">;
```

在 `statusLabels` 加入：

```ts
certificate: "证书模板已连接云端",
```

在侧栏视频收集后增加：

```tsx
<button className={`rail-link ${activeWorkspace === "certificate" ? "active" : ""}`} type="button" onClick={() => chooseWorkspace("certificate")}>
  <span>07</span>证书制作
</button>
```

把现有“邮件分支结束后直接进入媒体分支”的连接改为以下精确分支；其后的现有媒体 JSX 内容不做任何修改：

```tsx
) : activeWorkspace === "certificate" ? (
  <CertificateWorkspace />
) : (
  <section className="workspace-view" id={`${activeMediaKind}-workspace`} aria-labelledby={`${activeMediaKind}-title`}>
```

上面的 `<section>` 是现有媒体分支的原始首行，继续保留该分支已有的全部子节点和闭合标签。

不要把 `certificate` 加入 `selectedFiles`、凡科采集、阿里邮箱采集或媒体上传类型。证书组件自行读取模板 API，父控制台不持有学校和人员名单。

- [ ] **Step 4: Run navigation and existing collector boundary tests**

Run:

```powershell
node --test --test-name-pattern="seven focused workspaces|Fanke helper and media workspaces|declares.*workspaces" tests/rendered-html.test.mjs
```

Expected: PASS；证书工作区位于第七位，凡科和媒体类型仍不包含 `certificate`。

- [ ] **Step 5: Commit the dashboard integration**

```powershell
git add app/collector-dashboard.tsx tests/rendered-html.test.mjs
git commit -m "feat: connect certificate workspace to dashboard"
```

---

### Task 5: Documentation, Full Regression, and Visual/PDF Acceptance

**Files:**
- Modify: `README.md`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4 的完整证书模块。
- Produces: 可复现的操作说明和通过全部自动、视觉、PDF、隐私检查的本地版本。

- [ ] **Step 1: Add a failing README regression assertion**

```js
test("documents the seven-workspace flow and private certificate generation", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /七个工作区/);
  assert.match(readme, /证书制作/);
  assert.match(readme, /赛事名称.*落款.*公章/s);
  assert.match(readme, /学校、奖项、指导教师和参赛队员.*浏览器本地/s);
  assert.match(readme, /不会保存.*证书历史/s);
});
```

- [ ] **Step 2: Run the README test and verify it fails**

Run:

```powershell
node --test --test-name-pattern="private certificate generation" tests/rendered-html.test.mjs
```

Expected: FAIL because README still describes six workspaces and has no certificate privacy boundary.

- [ ] **Step 3: Document the operator workflow**

在 `README.md`：

- 把“六个工作区”改为“七个工作区”，按实际导航顺序列出证书制作；
- 说明首次保存赛事名称、落款和公章，后续只需填写学校、奖项、教师、队员和月份；
- 说明竞赛年份来自 EDP 审核设置；
- 说明 PDF 在浏览器本地生成，学校和人员名单不上传、不保存证书历史；
- 说明单张证书上限为 5 名指导教师和 15 名参赛队员；
- 说明网站只生成草稿文件，不会自动发送或公开发布。

- [ ] **Step 4: Run the complete automated verification suite**

Run in order:

```powershell
npm test
npm run lint
npm run build
git diff --check
```

Expected: all tests pass, ESLint exits 0, production build completes, and `git diff --check` prints no errors. If a command fails, stop this task, return to the task that owns the failing behavior, add or tighten its focused regression test, fix it, and rerun all four commands from the beginning.

- [ ] **Step 5: Perform local visual and PDF acceptance**

Start the local site without changing the shared password:

```powershell
npm run dev
```

After logging in with the existing local shared password:

1. Open “07 证书制作”.
2. Save a test template with a non-production test stamp, two-line footer and the approved event name.
3. Enter 天津大学、性能竞赛二等奖、5 名教师、15 名队员 and a month.
4. Check desktop width near 1440 px and mobile width near 390 px; no horizontal page overflow, all controls remain usable.
5. Download the PDF and use the PDF inspection skill to render page 1; verify title, school, complete award name, all 20 names, footer, proportional stamp and `YYYY年M月` are visible inside the border.
6. In browser network tools, confirm generation triggers no request containing school, award, teacher or member values; only template read/write and stamp requests are allowed.
7. Replace the stamp once and verify a failed invalid replacement leaves the previous stamp usable.

Do not use a real official seal for QA. If the local password or browser UI is unavailable, record visual acceptance as outstanding instead of claiming it passed; automatic tests and static inspection do not substitute for the rendered-page check.

- [ ] **Step 6: Commit the verified documentation**

```powershell
git add README.md tests/rendered-html.test.mjs
git commit -m "docs: explain team certificate workflow"
```

- [ ] **Step 7: Confirm release boundary and clean worktree scope**

Run:

```powershell
git status --short --branch
git log -5 --oneline
```

Expected: certificate source, tests, migration and README changes are committed; the pre-existing untracked `chemecar-sites-8a827bc87e5c.tar.gz` remains uncommitted. Do not package, save a Sites version, or deploy publicly until the user separately approves a release.
