# EDP 多格式压缩包、报名表联动与审核任务恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ZIP、7z、RAR 格式的合格 EDP 均可被准确收集和审核，允许包内携带一份报名表并复用现有报名更新流程，同时补建历史缺失的审核任务并简化审核设置与操作界面。

**Architecture:** 新增一个 Cloudflare Worker 可用的统一压缩包读取层，再由独立的 EDP 包解析器完成安全检查、核心 PDF 角色分类和报名表旁路识别。收集 API、凡科助手和审核引擎复用同一解析结果；D1 保存提交轮次、真实压缩格式和报名表同步状态，R2 继续保存每校最新原始压缩包。审核任务补建调用现有幂等建任务函数，不新建第二套审核记录。

**Tech Stack:** TypeScript 5.9、React 19、Vinext、Cloudflare Workers/D1/R2、JSZip、libarchive-wasm 1.2.0、PDF.js、SheetJS、Node test、Miniflare、ESLint。

**Spec:** `docs/superpowers/specs/2026-09-06-edp-multi-archive-registration-review-recovery-design.md`

## Global Constraints

- 暂不公开发布，不调用 Sites hosting；完成后仅保留可在 ChatGPT/Codex 中打开的本地预览。
- 不改变共享密码认证、同源写入校验、删除二次确认、每校最新版比较、R2 条件写入和审核任务唯一约束。
- 不自动发送邮件，也不把 EDP 首页邮箱当作回执收件人。
- 不添加文件 hash、冻结 contract、baseline 或新的业务 gate。
- 仅在 `edp_submissions` 新字段上保留轮次与格式的有限值校验。具体失败场景是：旧脚本或直接 D1 写入可绕过已擦除的 TypeScript 类型，写入轮次 `9` 或格式 `exe`，随后审核会按错误数量规则处理或调用错误解包器；Git、版本号、主键、事务、唯一约束和普通测试都不能约束部署后的直接数据库值。
- 迁移 `0017` 只追加、不可改写既有 `0000`–`0016`；不在运行时 `ensureSchema()` 中重复执行 `ALTER TABLE`，由 Sites/D1 迁移拥有生产字段变化。
- 压缩包最多 100 个条目，目录深度最多 12 层，单文件解压后最多 30 MiB，总解压数据最多 80 MiB；损坏、加密或需要密码的 ZIP/7z/RAR 均拒绝。
- 视觉方向为“安静、清晰的赛事资料操作台”：深海军蓝用于结构和标题，亮蓝只用于主操作，白色与浅灰蓝承载数据；不增加装饰图片。
- 所有新行为先出现可解释的失败测试，再做最小实现；每个任务完成后运行其定向测试并提交。

---

## Task 1: 验证 Worker 中的 7z/RAR 解包能力并建立统一读取层

**Files:**

- Create: `worker/edp-archive-core.ts`
- Create: `worker/edp-archive.ts`
- Create: `tests/fixtures/edp/nested-round2.7z`
- Create: `tests/fixtures/edp/nested-round2.rar`
- Create: `tests/fixtures/edp/encrypted-round2.7z`
- Create: `tests/fixtures/edp/README.md`
- Modify: `app/vite-env.d.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add small, non-user test archives and document their contents**

Create three deterministic fixtures. `nested-round2.7z` and `nested-round2.rar` each contain one directory named `南京工业大学/` and exactly these four small PDF-header files:

```text
南京工业大学/南京工业大学2026中文版4.0.pdf
南京工业大学/Nanjing Tech University 2026 English 4.0.pdf
南京工业大学/南京工业大学EDP增补文件.pdf
南京工业大学/南京工业大学MOC.pdf
```

`encrypted-round2.7z` contains the same names but requires password `fixture-only`; the application must reject it without attempting that password. In `tests/fixtures/edp/README.md`, record that all PDFs are synthetic test data, contain no team information, and exist only to test enumeration, nested paths and encryption rejection.

- [x] **Step 2: Add failing archive format and reader tests**

Add a `loadEdpArchiveCore()` helper to `tests/rendered-html.test.mjs`. It transpiles `worker/edp-archive-core.ts`, replaces the `jszip` import with `import.meta.resolve("jszip")`, and accepts a `readLibarchiveEntries` dependency created from the Node entry point of `libarchive-wasm`.

Add assertions equivalent to:

```js
test("EDP archive reader treats ZIP, 7z and RAR as the same safe entry model", async () => {
  const { openEdpArchiveCore, sniffEdpArchiveFormat } = await loadEdpArchiveCore();
  const sevenZip = new Uint8Array(await readFile(new URL("./fixtures/edp/nested-round2.7z", import.meta.url)));
  const rar = new Uint8Array(await readFile(new URL("./fixtures/edp/nested-round2.rar", import.meta.url)));

  assert.equal(sniffEdpArchiveFormat(sevenZip, "南京工业大学.7z"), "7z");
  assert.equal(sniffEdpArchiveFormat(rar, "南京工业大学.rar"), "rar");

  for (const [bytes, filename] of [[sevenZip, "南京工业大学.7z"], [rar, "南京工业大学.rar"]]) {
    const archive = await openEdpArchiveCore(bytes, filename, { readLibarchiveEntries });
    assert.equal(archive.entries.filter((entry) => !entry.isDirectory).length, 4);
    assert.ok(archive.entries.every((entry) => !entry.normalizedPath.includes("..")));
  }
});

test("EDP archive reader rejects extension spoofing, unsafe paths and encrypted archives", async () => {
  const { openEdpArchiveCore, EdpArchiveError } = await loadEdpArchiveCore();
  await assert.rejects(
    () => openEdpArchiveCore(new TextEncoder().encode("not an archive"), "fake.rar", { readLibarchiveEntries }),
    (error) => error instanceof EdpArchiveError && error.code === "archive_signature_mismatch",
  );
  const encrypted = new Uint8Array(await readFile(new URL("./fixtures/edp/encrypted-round2.7z", import.meta.url)));
  await assert.rejects(
    () => openEdpArchiveCore(encrypted, "encrypted-round2.7z", { readLibarchiveEntries }),
    (error) => error instanceof EdpArchiveError && error.code === "encrypted_archive",
  );
});
```

Run:

```powershell
node --test --test-name-pattern "EDP archive reader" tests/rendered-html.test.mjs
```

Expected: FAIL because the archive modules and dependency do not exist.

- [x] **Step 3: Install the one required extraction dependency**

Run:

```powershell
npm install libarchive-wasm@1.2.0
```

Inspect `package.json` and `package-lock.json`; no unrelated dependency upgrades are allowed. The selected library is MIT licensed and its documented formats include ZIP, 7-Zip and RAR v4/v5.

- [x] **Step 4: Implement the format-neutral core contract**

Define these exported types in `worker/edp-archive-core.ts`:

```ts
export type EdpArchiveFormat = "zip" | "7z" | "rar";

export type EdpArchiveErrorCode =
  | "unsupported_archive_format"
  | "archive_signature_mismatch"
  | "invalid_archive"
  | "encrypted_archive"
  | "unsafe_archive_path"
  | "archive_too_large"
  | "archive_entry_unreadable";

export interface EdpArchiveEntry {
  originalPath: string;
  normalizedPath: string;
  displayPath: string;
  displayNameStatus: "reliable" | "recovered" | "uncertain";
  isDirectory: boolean;
  declaredSize: number | null;
  bytes: Uint8Array | null;
}

export interface OpenedEdpArchive {
  format: EdpArchiveFormat;
  entries: EdpArchiveEntry[];
}

export interface LibarchiveEntryPayload {
  pathname: string;
  size: number | null;
  isDirectory: boolean;
  bytes: Uint8Array | null;
}

export interface EdpArchiveDependencies {
  readLibarchiveEntries(bytes: Uint8Array): Promise<LibarchiveEntryPayload[]>;
}

export class EdpArchiveError extends Error {
  constructor(readonly code: EdpArchiveErrorCode, message: string) { super(message); }
}

export function sniffEdpArchiveFormat(bytes: Uint8Array, filename: string): EdpArchiveFormat;

export async function openEdpArchiveCore(
  bytes: Uint8Array,
  filename: string,
  dependencies: EdpArchiveDependencies,
): Promise<OpenedEdpArchive>;
```

Implement ZIP with JSZip and 7z/RAR with the injected reader. Both paths must pass through one normalization and limit function that:

- converts `\` to `/` and removes redundant `.` segments;
- rejects NUL, absolute, drive-letter and `..` segments before returning entries, so directory-traversal（目录穿越）entries never reach storage or review;
- rejects depth greater than 12;
- decodes ZIP names as strict UTF-8 first and falls back to GB18030 only when UTF-8 is invalid; names containing replacement characters after decoding remain `uncertain` rather than being guessed;
- ignores no files at this layer, so the business parser can report them accurately;
- counts every declared entry toward the 100-entry limit;
- requires a safe declared size for each non-directory entry before reading it;
- refuses any single entry above 30 MiB and cumulative non-directory bytes above 80 MiB;
- maps password/encryption errors to `encrypted_archive` and all other parse failures to Chinese `invalid_archive` messages.

Use the file header as authority and the extension as a consistency check:

```text
ZIP: 50 4B 03 04, 50 4B 05 06, or 50 4B 07 08
7z:  37 7A BC AF 27 1C
RAR4: 52 61 72 21 1A 07 00
RAR5: 52 61 72 21 1A 07 01 00
```

- [x] **Step 5: Add the Cloudflare precompiled-Wasm facade**

In `worker/edp-archive.ts`, export the production entry point:

```ts
export async function openEdpArchive(
  bytes: Uint8Array,
  filename: string,
): Promise<OpenedEdpArchive>;
```

Keep JSZip lazy and instantiate libarchive only for 7z/RAR. Import `libarchive-wasm/dist/libarchive.wasm?module` as a precompiled `WebAssembly.Module`, pass an Emscripten `instantiateWasm(imports, receiveInstance)` override to `libarchiveWasm`, construct `ArchiveReader`, copy each current entry's bytes while the iterator is valid, and call `reader.free()` in `finally`. Add the narrow `*.wasm?module` declaration needed by TypeScript to `app/vite-env.d.ts`.

Do not use `WebAssembly.instantiateStreaming()` or compile raw Wasm bytes at request time; Cloudflare Workers require build-time module import. Sources for this constraint:

- `https://github.com/ofk/libarchive-wasm`
- `https://developers.cloudflare.com/workers/runtime-apis/webassembly/`
- `https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/`

- [x] **Step 6: Prove both behavior and Worker bundling**

Run:

```powershell
node --test --test-name-pattern "EDP archive reader" tests/rendered-html.test.mjs
npm run build
```

Expected: PASS. The build must emit `dist/server/index.js` without runtime Wasm compilation or unresolved `.wasm` imports. The implementation is complete only when the Emscripten `instantiateWasm` override passes both commands without changing the common contract or business rules.

- [x] **Step 7: Commit the archive layer**

```powershell
git add package.json package-lock.json app/vite-env.d.ts worker/edp-archive-core.ts worker/edp-archive.ts tests/fixtures/edp tests/rendered-html.test.mjs
git commit -m "feat: add safe multi-format EDP archive reader"
```

---

## Task 2: Build one EDP package parser with filename and PDF evidence

**Files:**

- Create: `worker/edp-package.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add failing classification tests for the reported schools**

Add a loader for `worker/edp-package.ts` and test its pure dependency-injected interface. Cover:

- a root school directory does not count as a file;
- `南京工业大学2026中文版4.0.pdf` becomes `chinese_edp` from first-page Chinese EDP title even without `EDP` in the filename;
- garbled display names can be classified from readable first-page text without presenting mojibake as the reason;
- one Chinese, one English, one supplement and one MOC pass rounds 2–5;
- round 1 passes exactly the first three roles and rejects MOC;
- duplicate or ambiguous roles remain an explicit classification error;
- one `.xlsx` is returned as a sidecar candidate and excluded from `coreFileCount`;
- multiple `.xlsx` candidates are returned for the caller to mark as a sidecar failure without failing four valid core PDFs;
- any other non-PDF/non-XLSX business file fails core validation.

Use this representative test:

```js
test("EDP package parser uses content evidence and excludes one registration sidecar from core count", async () => {
  const { inspectEdpPackage } = await loadEdpPackage();
  const result = await inspectEdpPackage(archiveBytes, "南京工业大学.7z", 2, {
    openArchive: async () => syntheticEntries,
    extractFirstPageText: async (_bytes, path) => firstPageTextByPath[path] || "",
  });

  assert.equal(result.qualified, true);
  assert.equal(result.archiveFormat, "7z");
  assert.equal(result.coreFileCount, 4);
  assert.deepEqual(result.documents.map(({ role }) => role).sort(),
    ["chinese_edp", "english_edp", "moc", "supplement"]);
  assert.equal(result.registrationCandidates.length, 1);
});
```

Run:

```powershell
node --test --test-name-pattern "EDP package parser" tests/rendered-html.test.mjs
```

Expected: FAIL because the parser is absent.

- [x] **Step 2: Implement the package model and strict role assignment**

Export this contract from `worker/edp-package.ts`:

```ts
export type EdpDocumentRole = "chinese_edp" | "english_edp" | "supplement" | "moc";
export type EdpSubmissionRound = 1 | 2 | 3 | 4 | 5;
export type EdpReasonCode = "file_count" | "file_format" | "classification";

export interface EdpPackageDocument {
  role: EdpDocumentRole;
  path: string;
  displayPath: string;
  bytes: Uint8Array;
  roleEvidence: "filename" | "first_page" | "unique_remaining_role";
}

export interface EdpRegistrationCandidate {
  path: string;
  displayPath: string;
  bytes: Uint8Array;
}

export interface EdpPackageInspection {
  qualified: boolean;
  archiveFormat: EdpArchiveFormat | null;
  coreFileCount: number;
  visibleFileCount: number;
  documents: EdpPackageDocument[];
  registrationCandidates: EdpRegistrationCandidate[];
  reasonCode?: EdpReasonCode;
  reasonCodes: EdpReasonCode[];
  reasons: string[];
}

export interface InspectEdpPackageOptions {
  openArchive?: typeof openEdpArchive;
  extractFirstPageText?: (bytes: Uint8Array, path: string) => Promise<string>;
}

export async function inspectEdpPackage(
  bytes: Uint8Array,
  filename: string,
  submissionRound: EdpSubmissionRound,
  options?: InspectEdpPackageOptions,
): Promise<EdpPackageInspection>;
```

Classification order must be deterministic. `displayNameStatus: "uncertain"` prevents a filename-only positive result, but still allows first-page evidence or a unique remaining-role assignment:

1. Filename keywords: `MOC/变更管理`, `Supplement/Addendum/增补/补充/补遗`, `English/英文/英语`, `Chinese/中文版/中文/工程文件包`.
2. First-page evidence: explicit `Management of Change`, `EDP Supplement`, English EDP title, or Chinese EDP title and Chinese form headings.
3. Assign an unclassified PDF only when exactly one expected role and exactly one document remain; record `unique_remaining_role`.
4. If more than one mapping remains possible, return one Chinese message listing every ambiguous display name.

Ignore directory entries and `__MACOSX`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`. For every core PDF require both `.pdf` and `%PDF-`. Preserve the 3-file/4-file rules by submission round. Use PDF.js only for PDFs whose filename does not already give a unique role, so ordinary packages do not pay an unnecessary second parse.

Make `worker/edp-package.ts` the single owner of `EdpSubmissionRound` and `EdpReasonCode`. `worker/index.ts` imports those types; `worker/edp-review-engine.ts` imports and re-exports `EdpSubmissionRound` so the existing review API import remains valid. Do not leave separate local unions that can drift.

- [x] **Step 3: Verify parser behavior**

Run:

```powershell
node --test --test-name-pattern "EDP package parser" tests/rendered-html.test.mjs
```

Expected: PASS for the nested, evidence-driven, ambiguous, sidecar and round cases.

- [x] **Step 4: Commit the parser**

```powershell
git add worker/edp-package.ts tests/rendered-html.test.mjs
git commit -m "feat: classify EDP package documents from shared evidence"
```

---

## Task 3: Persist archive, round and embedded-registration metadata

**Files:**

- Modify: `db/schema.ts`
- Create: `drizzle/0017_edp_submission_archive_metadata.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `worker/index.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add a failing migration preservation test**

Create the `0017` test alongside the `0015` and `0016` tests. Apply `0001_edp_collector.sql`, insert a legacy ZIP row, then apply `0017` and assert:

```js
assert.deepEqual(await database.prepare(`SELECT submission_round, submission_round_source,
  archive_format, embedded_registration_filename, embedded_registration_status,
  embedded_registration_message FROM edp_submissions`).first(), {
  submission_round: null,
  submission_round_source: "legacy_unknown",
  archive_format: "zip",
  embedded_registration_filename: null,
  embedded_registration_status: "none",
  embedded_registration_message: null,
});
```

Also assert D1 rejects `submission_round = 6` and `archive_format = 'exe'`, and that the journal's final tag is `0017_edp_submission_archive_metadata`.

Run:

```powershell
node --test --test-name-pattern "0017 EDP submission archive metadata migration" tests/rendered-html.test.mjs
```

Expected: FAIL because the migration and fields do not exist.

- [x] **Step 2: Extend the Drizzle schema and generate the custom migration entry**

Add these columns to `edpSubmissions`:

```ts
submissionRound: integer("submission_round"),
submissionRoundSource: text("submission_round_source").notNull().default("legacy_unknown"),
archiveFormat: text("archive_format").notNull().default("zip"),
embeddedRegistrationFilename: text("embedded_registration_filename"),
embeddedRegistrationStatus: text("embedded_registration_status").notNull().default("none"),
embeddedRegistrationMessage: text("embedded_registration_message"),
```

Run:

```powershell
npm run db:generate -- --custom --name=edp_submission_archive_metadata
```

Ensure the generated filename is `drizzle/0017_edp_submission_archive_metadata.sql` and replace its empty custom body with six bounded `ALTER TABLE ... ADD COLUMN` statements. Use constant defaults for all new `NOT NULL` columns. Add `CHECK (submission_round IS NULL OR submission_round BETWEEN 1 AND 5)`, `CHECK (archive_format IN ('zip','7z','rar'))`, and `CHECK (embedded_registration_status IN ('none','synced','older','invalid'))`. Do not add an index because current lookups already use the `(user_id, school_key)` primary key or the existing review-job unique index.

- [x] **Step 3: Extend the server row and recovery metadata**

In `worker/index.ts`, extend `EdpSubmissionRow` with:

```ts
content_type: string;
submission_round: EdpSubmissionRound | null;
submission_round_source: "captured" | "legacy_unknown" | "inferred_file_count" | "inferred_current_setting";
archive_format: EdpArchiveFormat;
embedded_registration_filename: string | null;
embedded_registration_status: "none" | "synced" | "older" | "invalid";
embedded_registration_message: string | null;
has_review_job?: number;
```

Update every `edp_submissions` SELECT, `prepareEdpSubmissionUpsert`, `edpRowFromObject`, `storeEdpIfNewest`, `edpSubmissionFromRow` and dashboard mapping. Store `submissionRound`, `submissionRoundSource`, `archiveFormat` and `contentType` in R2 custom metadata so the existing R2-before-D1 recovery path can reconstruct the current row. Embedded-registration status is written after the EDP row exists and therefore remains D1 metadata; an R2-recovered row starts at `none` and may be processed again by the normal collection retry. The download response must use the persisted `content_type`, not the ZIP constant.

In the dashboard SELECT, derive task state without adding a redundant status column:

```sql
CASE WHEN EXISTS (
  SELECT 1 FROM edp_review_jobs AS review
  WHERE review.user_id = edp_submissions.user_id
    AND review.school_key = edp_submissions.school_key
    AND review.submission_id = edp_submissions.submission_id
    AND review.status <> 'superseded'
) THEN 1 ELSE 0 END AS has_review_job
```

Map this to `reviewTaskStatus: "created" | "missing"` in the JSON response. Derive `documentRoles` from the persisted round: rounds 2–5 include all four roles, while round 1 omits MOC; a null legacy round returns an empty role list until synchronization resolves it.

- [x] **Step 4: Run migration and legacy API regression tests**

```powershell
node --test --test-name-pattern "0017 EDP submission archive metadata migration|keeps the last qualified EDP" tests/rendered-html.test.mjs
```

Expected: PASS; the old ZIP fixture remains readable with `archiveFormat: "zip"` and the legacy row is preserved.

- [x] **Step 5: Commit the schema slice**

```powershell
git add db/schema.ts drizzle/0017_edp_submission_archive_metadata.sql drizzle/meta/_journal.json worker/index.ts tests/rendered-html.test.mjs
git commit -m "feat: persist EDP archive and sidecar metadata"
```

---

## Task 4: Extract the existing registration ingestion workflow for safe reuse

**Files:**

- Modify: `worker/index.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add standalone registration characterization coverage**

Before refactoring, add an API test that uploads a valid registration, uploads an older copy, and uploads the same version again. Assert the current behavior remains:

```js
assert.equal(firstPayload.accepted, true);
assert.equal(olderPayload.reason, "older-or-equal");
assert.equal(duplicatePayload.reason, "duplicate");
assert.equal((await dashboard.json()).registrations.length, 1);
```

Run:

```powershell
node --test --test-name-pattern "reusable registration ingestion preserves standalone upload semantics" tests/rendered-html.test.mjs
```

Expected: PASS before the refactor; this test is the behavior lock that must stay green while code is moved.

- [x] **Step 2: Introduce one internal ingestion function**

Keep storage helpers in `worker/index.ts` and introduce:

```ts
interface RegistrationIngestResult {
  accepted: boolean;
  reason?: "duplicate" | "older-or-equal" | "superseded";
  message?: string;
  masterSync?: MasterSyncResult;
  row: RegistrationRow;
  assessment: RegistrationAssessment;
}

async function ingestRegistrationFile(
  env: Env,
  userId: string,
  input: {
    file: File;
    schoolName: string;
    submittedAt: string;
    submissionId: string;
    enforceStart: boolean;
  },
): Promise<RegistrationIngestResult>;
```

Move workbook assessment, school verification, newest-version comparison, conditional R2 write, D1 upsert, receipt creation and master synchronization into this function without changing their order. `uploadRegistration()` remains the multipart HTTP wrapper and calls it with `enforceStart: !metadata.manual`.

The function must continue storing a structurally valid but business-unqualified workbook, generate its precise failed-registration receipt, and skip master-table update through `unqualifiedMasterSync()`.

- [x] **Step 3: Re-run all registration and master-table cases**

```powershell
node --test --test-name-pattern "registration|报名表|master workbook|unique master" tests/rendered-html.test.mjs
```

Expected: PASS with no response-shape regression.

- [x] **Step 4: Commit the refactor**

```powershell
git add worker/index.ts tests/rendered-html.test.mjs
git commit -m "refactor: share registration ingestion workflow"
```

---

## Task 5: Integrate multi-format validation, embedded registration and Fanke collection

**Files:**

- Modify: `worker/index.ts`
- Modify: `worker/fanke-collector.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add failing end-to-end EDP upload cases**

Add built-Worker API tests for:

1. 南京理工大学 ZIP with a root folder and four PDFs passes round 2.
2. 南京工业大学 7z with content-classified Chinese/English files passes round 2.
3. 中国海洋大学 RAR passes round 2 and downloads with `application/vnd.rar` plus the original `.rar` filename.
4. 沈阳化工大学 package with four core PDFs and one valid same-school registration passes; the registration appears in `/api/dashboard` and its EDP row reports `embeddedRegistrationStatus: "synced"`.
5. A newer embedded registration replaces the old registration, while an older one reports `older` and does not overwrite it.
6. A structurally valid but business-unqualified registration is saved with its failed receipt while the EDP stays qualified.
7. A damaged, wrong-school or multiple-XLSX sidecar leaves the EDP accepted but records `embeddedRegistrationStatus: "invalid"` and a Chinese message.
8. A newer invalid core package does not replace the prior qualified package.
9. Encrypted 7z/RAR reports a Chinese format failure and does not write R2.

Also assert all upload prompts and failure messages say “ZIP、7z 或 RAR 压缩包” instead of “ZIP 文件”.

Representative assertions:

```js
assert.equal(payload.accepted, true);
assert.equal(payload.qualified, true);
assert.equal(payload.submission.archiveFormat, "7z");
assert.equal(payload.submission.fileCount, 4);
assert.equal(payload.submission.embeddedRegistration.status, "synced");
assert.equal(payload.submission.reviewTaskStatus, "created");
```

Run:

```powershell
node --test --test-name-pattern "nested EDP|multi-format EDP|embedded registration" tests/rendered-html.test.mjs
```

Expected: FAIL because upload remains ZIP-only and counts XLSX as a fifth business file.

- [x] **Step 2: Replace ZIP-only validation with the shared inspection**

Remove `EdpZipEntry`, `originalZipEntryName`, `hasUnsafeZipPath`, `isIgnoredZipEntry`, `classifyEdpFilename` and `validateEdpZip` from `worker/index.ts`. In `uploadEdpSubmission()`:

1. Read the candidate once into `Uint8Array` after checking the existing upload limit.
2. Require saved EDP receipt settings to include a round 1–5.
3. Call `inspectEdpPackage(bytes, filename, submissionRound)`.
4. Preserve the existing latest-qualified-versus-latest-issue comparison.
5. Store the original bytes with format-specific content type and captured round metadata.
6. Persist the accepted EDP before attempting the optional registration sidecar.
7. Process the sidecar, update only the exact current EDP row's embedded status, then queue the review task.

Map content types with one function:

```ts
function edpArchiveContentType(format: EdpArchiveFormat): string {
  if (format === "7z") return "application/x-7z-compressed";
  if (format === "rar") return "application/vnd.rar";
  return "application/zip";
}
```

Keep the internal R2 key `current.zip` for compatibility; the stored filename, content type and `archive_format` are authoritative for downloads and parsing.

- [x] **Step 3: Process registration candidates without reversing EDP success**

Add:

```ts
async function syncEmbeddedRegistration(
  env: Env,
  userId: string,
  edp: EdpSubmissionRow,
  candidates: readonly EdpRegistrationCandidate[],
): Promise<{
  filename: string | null;
  status: "none" | "synced" | "older" | "invalid";
  message: string | null;
}>;
```

Rules:

- zero candidates returns `none`;
- more than one returns `invalid` and lists all display names;
- one candidate becomes a File with the original basename and XLSX content type, then calls `ingestRegistrationFile(..., enforceStart: false)` using the EDP's school, timestamp and submission ID;
- `accepted: true` or same-version repair returns `synced`;
- `older-or-equal` returns `older`;
- `RegistrationWorkbookError`, school mismatch or master-sync failure returns `invalid` with the specific Chinese reason;
- a business-unqualified assessment still returns `synced`, because the workbook itself became the latest registration and its receipt records the business issues.

Persist the result with a conditional update:

```sql
UPDATE edp_submissions
SET embedded_registration_filename = ?, embedded_registration_status = ?, embedded_registration_message = ?
WHERE user_id = ? AND school_key = ? AND submitted_at = ? AND submission_id = ?
```

This prevents a slower older request from writing its sidecar result onto a newer EDP row.

- [x] **Step 4: Allow ambiguous 7z/RAR candidates into the EDP deep validator**

In `worker/fanke-collector.ts`, change the EDP fallback from ZIP-only to:

```ts
if (targetKind === "edp" && file.kind === null && /\.(?:zip|7z|rar)$/iu.test(file.filename)) {
  return [{ ...file, kind: "edp" as const }];
}
```

Keep contextual classification ahead of this fallback so a form field explicitly labelled poster/video cannot enter the EDP queue. In `processFankeFile()`, construct an EDP File with `application/octet-stream`; `uploadEdpSubmission()` then performs the authoritative signature check and chooses the persisted content type. This ensures a damaged candidate becomes a normal EDP problem record instead of an assistant retry error.

Add a collection test where one mixed record contains `.xlsx`, ambiguous `.7z`, poster `.jpg` and video `.mp4`; an EDP scan queues only the `.7z` candidate, then the deep parser decides whether it is a valid EDP.

- [x] **Step 5: Verify reported workflows**

```powershell
node --test --test-name-pattern "nested EDP|multi-format EDP|embedded registration|Fanke.*EDP" tests/rendered-html.test.mjs
```

Expected: PASS; the沈阳化工 case reports four core PDFs rather than five business files.

- [x] **Step 6: Commit collection integration**

```powershell
git add worker/index.ts worker/fanke-collector.ts tests/rendered-html.test.mjs
git commit -m "feat: collect multi-format EDPs and embedded registrations"
```

---

## Task 6: Make the EDP audit engine consume the same package interpretation

**Files:**

- Modify: `worker/edp-review-engine.ts`
- Modify: `worker/edp-review-api.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add failing audit parity tests**

Run the same four synthetic PDF documents through ZIP, 7z and RAR and assert identical roles, rule IDs and overall status. Add a fifth registration workbook to the round-2 package and assert it is ignored by the technical audit but remains available through the registration reference lookup.

```js
for (const sample of samples) {
  const result = await auditEdpArchive(sample.bytes, {
    archiveFilename: sample.filename,
    submissionRound: 2,
    extractDocument,
  });
  assert.deepEqual(result.documents.map(({ role }) => role).sort(), expectedRoles);
  assert.deepEqual(result.items.map(({ ruleId }) => ruleId), expectedRuleIds);
}
```

Run:

```powershell
node --test --test-name-pattern "EDP audit archive parity" tests/rendered-html.test.mjs
```

Expected: FAIL because `auditEdpArchive` currently calls JSZip and rejects XLSX.

- [x] **Step 2: Remove the second ZIP parser from the audit engine**

Extend `EdpAuditContext` with required `archiveFilename: string`. Call `inspectEdpPackage()` with the stored submission round and filename. Translate its failure into generic archive error codes and messages; do not mention ZIP when the source is 7z/RAR.

For each `inspection.documents` entry, pass its bytes and already-determined role to `extractDocument`. Do not iterate `registrationCandidates` as review documents. Preserve all existing detailed safety, bilingual, cross-document, annual-rule and `needs_human` behavior.

Change `EdpAuditArchiveErrorCode` from `invalid_zip` to `invalid_archive`, retain the other safety codes, and include a `package_invalid` code for role/count failures. Update `runReview()` in `worker/edp-review-api.ts` to pass `job.source_filename || "EDP.zip"` as `archiveFilename`.

- [x] **Step 3: Run the audit corpus**

```powershell
node --test --test-name-pattern "EDP audit|EDP mixed evidence|EDP cross-document|EDP cover" tests/rendered-html.test.mjs
```

Expected: PASS with the same 32 built-in audit rules and no regression to the Chinese-template exemptions.

- [x] **Step 4: Commit shared audit parsing**

```powershell
git add worker/edp-review-engine.ts worker/edp-review-api.ts tests/rendered-html.test.mjs
git commit -m "refactor: audit EDPs through the shared package parser"
```

---

## Task 7: Backfill missing review tasks idempotently

**Files:**

- Modify: `worker/edp-review-api.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add failing sync API lifecycle tests**

Set up three accepted EDP rows:

- current row with captured round 2 and no job;
- legacy 3-file row with null round;
- legacy 4-file row with null round while current receipt setting is round 4.

POST `/api/edp-reviews/sync` twice. Assert the first result creates three jobs, records the two inference types, and the second creates zero without superseding or resetting any job.

```js
assert.deepEqual(firstPayload.summary, {
  created: 3,
  existing: 0,
  failed: 0,
  historicalRoundInferences: 2,
});
assert.deepEqual(secondPayload.summary, {
  created: 0,
  existing: 3,
  failed: 0,
  historicalRoundInferences: 0,
});
```

Add a fourth legacy 4-file row with no saved 2–5 receipt round and assert only that school appears in `failures`; the other schools still complete.

Run:

```powershell
node --test --test-name-pattern "syncs missing EDP review jobs" tests/rendered-html.test.mjs
```

Expected: FAIL with 404 because the route does not exist.

- [x] **Step 2: Implement the bounded sync service**

Export:

```ts
export interface EdpReviewSyncResult {
  created: number;
  existing: number;
  failed: number;
  historicalRoundInferences: number;
  failures: Array<{ schoolKey: string; schoolName: string; message: string }>;
}

export async function syncMissingEdpReviewJobs(
  env: EdpReviewApiEnv,
  userId: string,
): Promise<EdpReviewSyncResult>;
```

Read at most the current 500 `edp_submissions` rows for the shared workspace. Resolve round in this order:

1. persisted `submission_round`;
2. `file_count = 3` becomes round 1 and source `inferred_file_count`;
3. `file_count = 4` uses the saved `edp_receipt_settings.submission_round` only when it is 2–5, then source `inferred_current_setting`;
4. otherwise record a per-school failure.

When inferring, update the exact current submission only if its round is still null. For each row, resolve the active rule version, test the existing `(user, school, submission ID, rule version)` job, and call `queueEdpReviewForSubmission()` only when absent. Catch per-school failures and continue. Never modify `status`, items or exports of existing jobs.

Extend the review-list SELECT with a `LEFT JOIN edp_submissions AS submission` on user, school and submission ID. Add nullable `archive_format` and `submission_round_source` aliases to `ReviewJobRow`, and map them to `archiveFormat` and `submissionRoundSource` in `jobFromRow()`. Historical jobs no longer matching the current per-school EDP keep null metadata; the current task card receives its actual ZIP/7z/RAR format and can display “历史轮次按当前设置补全”.

- [x] **Step 3: Add the route before dynamic job routes**

In `handleEdpReviewApi()`:

```ts
if (url.pathname === "/api/edp-reviews/sync") {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const summary = await syncMissingEdpReviewJobs(env, userId);
  return json({ ok: true, summary });
}
```

Keep GET `/api/edp-reviews` read-only.

- [x] **Step 4: Verify idempotency and preservation**

```powershell
node --test --test-name-pattern "syncs missing EDP review jobs|EDP review API lifecycle" tests/rendered-html.test.mjs
```

Expected: PASS, including the existing unique-index regression.

- [x] **Step 5: Commit recovery API**

```powershell
git add worker/edp-review-api.ts tests/rendered-html.test.mjs
git commit -m "feat: recover missing EDP review jobs"
```

---

## Task 8: Lock fixed review personnel and keep the two-sheet Excel correct

**Files:**

- Modify: `worker/edp-review-api.ts`
- Modify: `worker/edp-review-workbook.ts`
- Modify: `tests/rendered-html.test.mjs`

- [x] **Step 1: Add failing settings and workbook tests**

PUT a valid year together with deliberately wrong personnel values. GET settings and export a workbook, then assert:

```js
assert.equal(settings.safetyReviewerName, "潘芳丽");
assert.equal(settings.safetyReviewerEmail, "service@chemecar.cn");
assert.equal(settings.expertMemberName, "华炜");
assert.equal(workbook.Sheets["1) EDP Cover Page"].E8.v, "潘芳丽");
assert.equal(workbook.Sheets["1) EDP Cover Page"].E9.v, "service@chemecar.cn");
assert.equal(workbook.Sheets["1) EDP Cover Page"].E10.v, "华炜");
assert.equal(workbook.Sheets["1) EDP Cover Page"].E11?.v ?? "", "");
assert.deepEqual(workbook.SheetNames, ["1) EDP Cover Page", "2) EDP Evaluation"]);
```

Run:

```powershell
node --test --test-name-pattern "fixed EDP review personnel|EDP review workbook" tests/rendered-html.test.mjs
```

Expected: FAIL because settings currently accept all five editable fields and E11 receives the expert email.

- [x] **Step 2: Make personnel server-owned constants**

In `worker/edp-review-api.ts`:

```ts
export const FIXED_EDP_REVIEW_PERSONNEL = Object.freeze({
  safetyReviewerName: "潘芳丽",
  safetyReviewerEmail: "service@chemecar.cn",
  expertMemberName: "华炜",
});
```

`PUT /api/edp-reviews/settings` accepts and validates only `competitionYear`, but writes these constants plus an empty `expert_member_email` to the legacy columns. `settingsFromRow()` always returns fixed personnel even if an older row contains different text. Preserve active annual-rule fields and template version.

- [x] **Step 3: Remove expert email from the workbook contract**

Delete required `expertMemberEmail` from `EdpReviewWorkbookPayload` and its call site. In `buildEdpReviewWorkbook()`, always clear E11 with `clearCell(coverXml, "E11")` and retain `removeTemplateEmailHyperlinks()` so stale example email text and links cannot survive.

- [x] **Step 4: Verify settings and exports**

```powershell
node --test --test-name-pattern "fixed EDP review personnel|EDP review workbook|two worksheets" tests/rendered-html.test.mjs
```

Expected: PASS with exactly two sheets and a blank expert-email cell.

- [x] **Step 5: Commit settings and export behavior**

```powershell
git add worker/edp-review-api.ts worker/edp-review-workbook.ts tests/rendered-html.test.mjs
git commit -m "feat: fix EDP review personnel and workbook fields"
```

---

## Task 9: Simplify and polish the EDP collection and review workspaces

**Files:**

- Modify: `app/collector-dashboard.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

- [ ] **Step 1: Add failing rendered-interface assertions**

Assert source/rendered output contains:

- `.zip,.7z,.rar` on manual EDP input;
- format, submission round, four roles, embedded-registration status and review-task status on accepted cards;
- a fixed-height scrollable issue list with an accessible label;
- “同步并刷新审核任务” and a summary for created/existing/failed;
- a competition-year `<select>`;
- read-only text “安全与规则审查人”“潘芳丽”“service@chemecar.cn”“专家组成员”“华炜”;
- no “专家组成员邮箱” label or input;
- status counts for 待审核、审核中、待人工确认、已完成、待补建;
- stable React keys from `schoolKey + submissionId` or `jobId`, never list index for EDP records.

Run:

```powershell
node --test --test-name-pattern "EDP workspaces expose multi-format status and fixed review settings" tests/rendered-html.test.mjs
```

Expected: FAIL against the current ZIP-only input and five-field settings form.

- [ ] **Step 2: Extend client response types and review synchronization state**

Extend `EdpSubmission` with:

```ts
archiveFormat: "zip" | "7z" | "rar";
submissionRound: 1 | 2 | 3 | 4 | 5 | null;
submissionRoundSource: "captured" | "legacy_unknown" | "inferred_file_count" | "inferred_current_setting";
documentRoles: string[];
embeddedRegistration: {
  filename: string | null;
  status: "none" | "synced" | "older" | "invalid";
  message: string | null;
};
reviewTaskStatus: "created" | "missing";
```

Add `EdpReviewSyncSummary` and a state value for the most recent sync result. Change:

```ts
async function refreshEdpReviews(options: { sync: boolean; announce: boolean }): Promise<void>
```

When `sync` is true, POST `/api/edp-reviews/sync` before the parallel GETs for settings, jobs and rules. Entering the review workspace calls `{ sync: true, announce: false }` once; the button calls `{ sync: true, announce: true }`. A per-school sync failure remains visible in the result panel while successfully created jobs still render.

- [ ] **Step 3: Simplify the settings card**

Build year options from the saved year plus current year - 1 through current year + 5, sorted numerically. Render one required `<select>` and three read-only personnel chips. Submit only:

```ts
body: JSON.stringify({ competitionYear: edpReviewSettings.competitionYear })
```

Use the exact label “安全与规则审查人邮箱”. Remove the expert email field from the client type and form.

- [ ] **Step 4: Recompose the EDP collection workspace around action and result**

At the top, keep the round selector, start date, Fanke one-click collection and manual archive upload. Change manual copy to “ZIP / 7z / RAR，最大 20MB” and accept:

```tsx
accept=".zip,.7z,.rar,application/zip,application/x-7z-compressed,application/vnd.rar"
```

On each accepted item show compact badges for archive format, round and the four classified roles. Show the embedded registration line only when status is not `none`; `invalid` uses a warning panel but does not label the EDP as failed. Show “审核任务已建立” or “审核任务待补建” beside the review action.

Wrap the issue records in:

```tsx
<div className="edp-issue-scroll" role="region" aria-label="全部 EDP 文件问题" tabIndex={0}>
  <ul className="record-list edp-records">...</ul>
</div>
```

Retain existing individual download, receipt, delete and multi-select/bulk-delete actions; destructive actions retain the current second confirmation.

- [ ] **Step 5: Recompose the review list and status summary**

Use five status counters and give the primary action label “同步并刷新审核任务”. Empty-state logic:

- no accepted EDP: “尚无通过格式与数量检查的 EDP”；
- accepted EDP count is greater than job count: “存在合格 EDP，审核任务待补建”；
- all accepted EDPs have jobs: render the job list.

Each task card shows school, round, ZIP/7z/RAR, rule year, status and one clear “查看并审核” button. Put long technical errors in a `<details>` block. Preserve `job.jobId` as the key.

- [ ] **Step 6: Apply shared visual tokens and touch-safe layout**

In `app/globals.css`:

- use `#0b2344`/`#123b6d` for structure, `#246bce` for primary actions, `#f3f7fc` for the page, and white cards with `#d5e0ed` borders;
- set normal body content to at least 16px and operational labels to at least 14px;
- ensure buttons, inputs and selects have `min-height: 44px`;
- keep at least 8px between adjacent controls;
- set `.edp-issue-scroll { max-height: 34rem; overflow-y: auto; scrollbar-gutter: stable; }`;
- make accepted/review cards denser on desktop without removing line breaks needed for Chinese text;
- at mobile breakpoints, switch settings, counters and actions to one column and keep destructive buttons separated from primary actions;
- retain visible `:focus-visible` outlines and 200% text zoom usability.

- [ ] **Step 7: Run UI assertions and a production build**

```powershell
node --test --test-name-pattern "EDP workspaces expose multi-format status and fixed review settings|renders the six-workspace" tests/rendered-html.test.mjs
npm run build
```

Expected: PASS with no TypeScript or CSS build error.

- [ ] **Step 8: Commit the workspace redesign**

```powershell
git add app/collector-dashboard.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: simplify EDP collection and review workspaces"
```

---

## Task 10: Update helper guidance, run full regression and publish the approved version

**Files:**

- Modify: `fanke-helper/安装说明.txt`
- Modify: `public/chemecar-fanke-helper.zip`
- Modify: `README.md`
- Modify: `tests/rendered-html.test.mjs`

- [ ] **Step 1: Add failing documentation/package assertions**

Extend the existing helper ZIP test to assert that the packaged guide says:

- EDP accepts ZIP, 7z and RAR;
- a school directory around the PDF files is allowed;
- an embedded same-school registration can update the registration workspace;
- encrypted archives are rejected;
- “同步并刷新审核任务” repairs missing tasks;
- the site never automatically sends receipt email.

Run:

```powershell
node --test --test-name-pattern "documents the six-workspace operator flow|helper package" tests/rendered-html.test.mjs
```

Expected: FAIL until source guide and packaged guide agree.

- [ ] **Step 2: Update operator documentation and rebuild the helper ZIP**

Edit `fanke-helper/安装说明.txt` and the EDP section in `README.md` with the exact operator flow. Rebuild `public/chemecar-fanke-helper.zip` from the contents of `fanke-helper/`, preserving UTF-8 filenames and excluding temporary files. Reopen the resulting ZIP with JSZip and verify `manifest.json`, all JavaScript files and `安装说明.txt` are present once.

- [ ] **Step 3: Run the complete automated verification set**

```powershell
npm test
npm run lint
git diff --check
git status --short
```

Expected:

- all Node/Miniflare tests pass after the production build;
- ESLint reports zero errors;
- `git diff --check` emits no output;
- `git status --short` lists only the intentional, not-yet-committed documentation/package files.

- [ ] **Step 4: Perform a local Site preview check**

Start the existing dev command in a retained terminal:

```powershell
npm run dev
```

Use the exact Local URL printed by the server and make one lightweight request to confirm a non-error response. Then follow the Sites hosting procedure for the existing project, save the verified version, deploy it publicly using the user's explicit approval, and verify the returned public URL.

- [ ] **Step 5: Commit the verified local release candidate**

```powershell
git add fanke-helper/安装说明.txt public/chemecar-fanke-helper.zip README.md tests/rendered-html.test.mjs
git commit -m "docs: explain multi-format EDP collection and recovery"
```

- [ ] **Step 6: Final evidence and deployment check**

```powershell
git status --short
git log --oneline -10
```

Expected: clean worktree. Report the public URL, deployed version identifier, four school scenarios verified, and automated command results.

---

## Completion Criteria

- 南京理工大学根目录文件夹内四份 PDF 被认定为合格 round-2 EDP。
- 南京工业大学不依赖完整 `EDP` 文件名也可由 PDF 首页证据正确分类。
- 沈阳化工大学四份核心 PDF 加报名表不再被报成五个 EDP 文件；报名表按同校真实提交时间更新报名栏目和统计表。
- 中国海洋大学 7z 和等价 RAR 能收集、下载、生成回执并进入审核；加密包安全拒绝。
- 新合格包自动有审核任务；历史合格包可通过幂等同步补建，重复同步不重复、不重置。
- 审核引擎对 ZIP、7z、RAR 得到一致文档角色和审核规则结果。
- 竞赛年份是唯一可编辑审核表设置；固定人员自动写入，两张 Excel 工作表保持，专家邮箱为空。
- EDP 错误清单可滚动查看全部项目，主操作至少 44px，桌面和手机布局均可使用。
- 完整测试、Lint、构建和差异检查通过；已按用户本轮明确批准更新并公开发布现有站点。
