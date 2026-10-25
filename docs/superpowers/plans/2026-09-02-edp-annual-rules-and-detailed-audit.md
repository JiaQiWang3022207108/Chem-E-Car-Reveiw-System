# EDP 年度规则库与细化审核实施计划

> 依据：`docs/superpowers/specs/2026-09-02-edp-annual-rules-and-detailed-audit-design.md`
>
> 执行方式：在当前隔离工作树内逐项测试驱动实现；每项先观察新增测试失败，再编写最小实现并回归。公开发布不包含在本计划的自动执行范围内，完成站点版本保存后单独取得用户发布确认。

## 目标与验收边界

本次开发要把年度竞赛规则 PDF 变成可追溯、需人工确认后才启用的规则版本，并把 EDP 审核扩展到首页字段、中英文客观一致性、工作安全评估、标准安全操作和近五年方案。系统继续保留现有两张审核工作表、现有采集流程、现有共享登录与阿里邮箱草稿边界，不发送邮件，不使用 EDP 首页邮箱作为收件人。

完成条件：

- 同一年仅有一个启用规则版本，历史审核锁定创建时的版本。
- 规则上传支持解析、年份冲突提示、人工确认启用、下载、候选删除和历史归档。
- EDP 审核项保存阻塞属性、规则来源、证据文件、页码与摘录。
- 小车照片显示为暂缓审核且不阻塞正式导出。
- 报名表邮箱缺失时跳过该校邮件草稿，批处理继续，绝不回退到 EDP 邮箱。
- Excel 仍严格只有 `1) EDP Cover Page` 与 `2) EDP Evaluation` 两张工作表。
- 新增迁移、构建、完整测试、Lint 和差异检查全部通过。

## Task 1：建立年度规则与审核证据的数据模型

**修改文件**

- 新增：`drizzle/0016_edp_annual_rules.sql`
- 修改：`tests/rendered-html.test.mjs`

### 1.1 先写失败测试

在迁移测试中执行 `0016_edp_annual_rules.sql`，断言：

- `edp_rule_documents` 包含用户、文档 ID、适用年份、输入年份、检测年份、文件名、R2 键、SHA-256、大小、状态、解析警告、内置审核版本和各时间字段。
- `edp_rule_facts` 包含稳定事实 ID、类别、章节、规范化要求、比较运算符、结构化值/单位、适用条件、来源页码、证据摘录、置信等级和确认状态。
- 文档状态只能为 `processing | needs_confirmation | active | archived | failed`。
- `edp_review_settings.active_rule_document_id` 能锁定当前选择。
- `edp_review_items.is_blocking` 默认 1，`rule_source` 默认内置规则来源。
- 同一用户、同一年最多一个 `active` 文档的约束由激活事务与查询测试共同保证。

执行：

```powershell
node --test --test-name-pattern "0016 EDP annual rule migration" tests/rendered-html.test.mjs
```

预期：因迁移文件和新字段不存在而失败。

### 1.2 实现迁移

创建以下结构：

- `edp_rule_documents` 主键 `(user_id, document_id)`；对 `(user_id, applicable_year, status, created_at)` 建查询索引；对 `sha256` 建去重辅助索引。
- `edp_rule_facts` 主键 `(user_id, document_id, fact_id)`；对文档和页码建索引。
- 向 `edp_review_settings` 增加 `active_rule_document_id TEXT`。
- 向 `edp_review_items` 增加 `is_blocking INTEGER NOT NULL DEFAULT 1 CHECK(is_blocking IN (0,1))` 与 `rule_source TEXT NOT NULL DEFAULT 'builtin:v1'`。

为 SQLite/D1 兼容，迁移只使用 D1 支持的 `ALTER TABLE ... ADD COLUMN`、表约束和普通索引；启用时通过一个数据库批次先归档旧版本再激活新版本。

### 1.3 验证并提交

运行迁移定向测试和现有 `0015` 迁移测试，确认旧审核记录仍可读取。提交信息：

```text
feat: add annual EDP rule storage
```

## Task 2：实现规则 PDF 的验证、解析和稳定版本号

**修改文件**

- 新增：`worker/edp-rule-parser.ts`
- 修改：`tests/rendered-html.test.mjs`

### 2.1 先写失败测试

为纯函数建立手工构造的 PDF/页面文本测试，覆盖：

- 非 `%PDF-` 文件头、超过 50 MiB、加密/损坏、零有效文本均被拒绝。
- 从“2026 中国大学生 Chem-E-Car 竞赛规则”等正文识别 2026；多个候选年份时给出警告而非猜测。
- 提取带页码的明确事实：数值比较、单位、必须/不得/允许/仅当、禁用或限制物质与条件性要求。
- 证据摘录有长度上限且不跨页伪造。
- 相同年份、相同 SHA-256 和相同内置版本生成相同规则版本；文件变化生成不同版本。
- 输入年份与检测年份冲突时返回 `yearConflict: true`。

新增核心接口：

```ts
export type EdpRuleDocumentStatus =
  | "processing"
  | "needs_confirmation"
  | "active"
  | "archived"
  | "failed";

export interface EdpRuleFactCandidate {
  factId: string;
  category: "numeric_limit" | "required" | "prohibited" | "allowed" | "conditional";
  section: string;
  normalizedRequirement: string;
  operator: "lt" | "lte" | "eq" | "gte" | "gt" | "must" | "must_not" | "may" | "conditional";
  value: string | null;
  unit: string | null;
  condition: string | null;
  page: number;
  excerpt: string;
  confidence: "high" | "medium" | "low";
}

export interface EdpRuleParseResult {
  detectedYear: number | null;
  warnings: string[];
  yearConflict: boolean;
  version: string;
  facts: EdpRuleFactCandidate[];
}
```

执行：

```powershell
node --test --test-name-pattern "annual EDP rule parser" tests/rendered-html.test.mjs
```

预期：模块不存在而失败。

### 2.2 实现最小解析器

- 使用现有 `pdfjs-dist` 在服务端逐页提取文字，不调用外部 AI 服务。
- 先验证大小、文件头和加载结果，再解析文字；将加密、损坏和空文本错误变成明确中文错误码/消息。
- 年份检测仅接受合理竞赛年份表达，返回候选列表和冲突警告。
- 事实抽取按句子和页码处理，保留原证据；数值统一运算符但不无依据换算单位。
- `factId` 由规范化类别、要求、条件和页码稳定哈希生成；文档版本由适用年份、PDF SHA-256 和 `EDP_REVIEW_RULE_VERSION` 生成。
- 低置信或不能结构化比较的句子仍保留候选，但默认不参与自动否决。

### 2.3 验证并提交

运行定向测试和 TypeScript 构建。提交信息：

```text
feat: parse annual EDP rule PDFs
```

## Task 3：实现年度规则文档 API 与 R2/D1 生命周期

**修改文件**

- 新增：`worker/edp-rule-api.ts`
- 修改：`worker/index.ts`
- 修改：`tests/rendered-html.test.mjs`

### 3.1 先写失败测试

使用现有 Fake D1/R2 与认证请求辅助函数覆盖：

- 未登录的读取和写入均被拒绝。
- `POST /api/edp-rule-documents` 接收 `multipart/form-data` 的 `year` 与 `file`，保存原 PDF、文档记录和事实记录，状态为 `needs_confirmation`。
- 同一 SHA-256 的同年重复上传返回已有候选，不重复写 R2。
- `GET` 列表和详情只返回当前共享用户空间的数据；详情带事实、警告和相对当前启用版的新增/删除/变化摘要。
- 年份冲突时普通激活返回 409；带显式 `confirmYearConflict: true` 才能激活。
- 激活新版本的 D1 batch 将同年旧 active 改为 archived，再把候选改为 active，并更新设置中的 active 文档 ID。
- 下载返回原 PDF 和安全的文件名。
- 未启用且未被审核任务引用的候选可删除；active、archived 或被引用文档返回 409 且 R2 不删除。
- 解析失败不改变当前 active 版本，并留下可读 `failed` 记录。

执行：

```powershell
node --test --test-name-pattern "annual EDP rule document API" tests/rendered-html.test.mjs
```

预期：路由返回 404 或模块不存在。

### 3.2 实现 API

`worker/edp-rule-api.ts` 导出统一路由处理器，内部实现：

- `listRuleDocuments`
- `uploadRuleDocument`
- `getRuleDocument`
- `activateRuleDocument`
- `downloadRuleDocument`
- `deleteRuleDocument`

上传先建立 processing 记录，再解析并写入 facts；任何错误都把记录改为 failed 并保留错误警告。数据库批量写入遵守 D1 每个 `prepare` 一条 SQL 的限制。R2 键使用用户 ID、年份、文档 ID 和经过清理的文件名，不信任浏览器 MIME。

在 `worker/index.ts` 的现有共享登录保护后挂载：

- `GET|POST /api/edp-rule-documents`
- `GET /api/edp-rule-documents/:id`
- `POST /api/edp-rule-documents/:id/activate`
- `GET /api/edp-rule-documents/:id/download`
- `DELETE /api/edp-rule-documents/:id`

### 3.3 验证并提交

运行 API 定向测试、认证回归测试与构建。提交信息：

```text
feat: manage annual EDP rule versions
```

## Task 4：扩展审核模型与总体状态语义

**修改文件**

- 修改：`worker/edp-review-rules.ts`
- 修改：`worker/edp-review-engine.ts`
- 新增：`worker/edp-detailed-audit.ts`
- 修改：`tests/rendered-html.test.mjs`

### 4.1 先写失败测试

用固定页面文本和手工结果断言：

- 每条审核结果包含 `isBlocking` 和 `ruleSource`。
- 总体状态只受阻塞项影响；照片为 `needs_human` 且 `isBlocking: false` 时仍允许整体 ready/passed。
- 阻塞项 `needs_human` 仍使正式结果为 needs_human。
- 年度规则事实只有 `confirmed` 且能做客观比较时参与判定；低置信候选或无可靠证据转 needs_human，不自动判否。
- 规则来源格式能区分 `builtin:<version>` 与 `annual:<document-version>:<fact-id>`。

执行：

```powershell
node --test --test-name-pattern "EDP blocking review semantics" tests/rendered-html.test.mjs
```

预期：旧模型缺少字段且总体状态仍被照片阻塞。

### 4.2 修改类型与总体计算

扩展：

```ts
export interface EdpReviewRuleResult {
  ruleId: string;
  row: number;
  status: EdpReviewStatus;
  isBlocking: boolean;
  ruleSource: string;
  evidence: EdpReviewEvidence[];
  suggestedComment: string;
}
```

- 内置规则默认阻塞，`vehicle_photo` 显式非阻塞且评论写明“暂缓审核”。
- `computeOverallReviewStatus` 忽略非阻塞 `needs_human`，但不忽略任何阻塞 `no`。
- 历史结果读取时缺少新字段则兼容为阻塞和内置 v1。

### 4.3 验证并提交

运行规则、引擎和旧 32 项规则回归测试。提交信息：

```text
feat: track blocking EDP audit evidence
```

## Task 5：首页字段与中英文客观一致性审核

**修改文件**

- 修改：`worker/edp-detailed-audit.ts`
- 修改：`worker/edp-review-engine.ts`
- 修改：`tests/rendered-html.test.mjs`

### 5.1 先写失败测试

以中英文页面文本和报名表摘要对象建立测试，覆盖：

- 八个首页字段的缺失、占位符、邮箱与日期格式。
- `OnsiteSafetyJudge`、`OnsiteTrackLength`、`OnsiteTrackWidth` 从不产生缺失意见。
- 学校、队长、指导教师、队名、Revision 和日期在中英文间明确冲突时为 no；可靠证据不足或合理翻译差异为 needs_human。
- 与最新报名表中可可靠提取字段明确不一致时为 no；报名表没有该字段时为 needs_human。
- 方程式、化学名和数值参数的明确冲突为 no；章节缺失为 no；仅翻译语义无法确定时为 needs_human。
- EDP 首页两类邮箱只出现在审核证据，不出现在回执 recipient 选择结果。

执行：

```powershell
node --test --test-name-pattern "EDP cover and bilingual audit" tests/rendered-html.test.mjs
```

预期：新审核项不存在。

### 5.2 实现结构化提取和比较

- 从每页文本提取带页码的首页标签值，去除模板占位符和重复页眉。
- 规范化中文空格、全半角标点、电子邮箱大小写、日期与 Revision；不把不同校区合并。
- 方程式比较保留反应物/产物两侧，规范化箭头、系数空格、上下标文字；不推断未写出的化学物。
- 数值比较保留原单位；同单位明确不同才自动判否，单位不同且无安全换算规则时 needs_human。
- 英文自由叙述语义不依赖关键词数量自动通过；客观对象一致后仍不能判断的部分保留人工确认。

### 5.3 验证并提交

运行新增测试和学校校区规范化回归测试。提交信息：

```text
feat: audit EDP cover and bilingual facts
```

## Task 6：工作安全评估、SOP 与近五年方案审核

**修改文件**

- 修改：`worker/edp-detailed-audit.ts`
- 修改：`worker/edp-review-engine.ts`
- 修改：`tests/rendered-html.test.mjs`

### 6.1 先写失败测试

覆盖以下客观行为：

- 动力和控制分别要求方程式、原理逻辑与关键操作条件；只有笼统名称时不自动通过。
- 辅助过程明确不适用为 not_applicable；存在辅助过程但缺过程/条件/风险/控制为 no；是否适用不清为 needs_human。
- 检出的化学、压力、机械、电气、热、泄漏、短路和误操作风险必须存在对应措施。
- 本年需要明确创新点；与已填写年份相同方程式产生可追踪的重复警告，只有年度启用规则明确禁止且证据完全相同时才自动 no。
- 现场电源明确不需要为 not_applicable；需要时缺设备、用途或电压/供电条件不能通过。
- SOP 六阶段均能识别，紧急停止超过两步为 no；四列缺失产生对应意见。
- 化学步骤只有“适量/少许/按需”而没有单位数值时为 no 或 needs_human；有化学名、量、温度/时间等条件时保留证据。
- 废物处理需包含废物流/成分或危险、容器、标签、兼容性/不得混合和赛后去向；只有“妥善处理”判为不充分。
- 近五年空白或“无”允许；已填年份缺动力、控制或反应原理为 no；明确重复/不同/无法判断分别输出 no/yes/needs_human 并带年份证据。

执行：

```powershell
node --test --test-name-pattern "EDP detailed safety SOP and history audit" tests/rendered-html.test.mjs
```

预期：详细审核项不存在。

### 6.2 实现分区审核器

将纯函数按职责拆分：

- `auditPowerAndControl`
- `auditAuxiliaryProcess`
- `auditRisksAndMitigations`
- `auditInnovationAndHistory`
- `auditOutletRequirement`
- `auditSopStages`
- `auditWasteHandling`

每个函数仅基于明确文本证据输出状态、阻塞属性、页码、摘录和具体补充意见。章节定位失败不伪造页码；文本质量低时统一转 needs_human。

### 6.3 验证并提交

运行详细审核和完整引擎测试。提交信息：

```text
feat: audit EDP safety SOP and design history
```

## Task 7：锁定规则版本、按最新规则复核和收件人边界

**修改文件**

- 修改：`worker/edp-review-api.ts`
- 修改：`worker/index.ts`
- 修改：`tests/rendered-html.test.mjs`

### 7.1 先写失败测试

断言：

- 创建审核任务时读取该竞赛年份 active 文档并把不可变版本号写入 job。
- 原审核任务重跑仍使用已锁定规则和 facts，后来激活的新规则不改变历史任务。
- `POST /api/edp-reviews/:id/recheck-latest` 创建一个新 job，使用当前 active 版本并保留来源 submission、旧任务和新任务关系。
- 保存 item 时写入 `is_blocking` 与 `rule_source`。
- 报名表最新有效收件邮箱被使用；EDP 首页邮箱即使有效也不得回退；无报名邮箱只跳过该校，批量草稿继续后续学校。

执行：

```powershell
node --test --test-name-pattern "EDP locked rule lifecycle and recipient boundary" tests/rendered-html.test.mjs
```

预期：复核路由 404、任务仍只认静态 v1 或 item 缺字段。

### 7.2 实现审核生命周期

- 将规则文档 ID/版本解析为任务级快照；运行审核时按 job.rule_version 查找对应文档 facts。
- recheck-latest 不覆写旧 job，以新 ID 创建任务并进入现有队列。
- 列表和详情 API 返回规则文件名、版本和是否为最新。
- 继续使用 `registration_receipts.recipient_email` 的最新有效值生成 EDP 回执；新增明确测试守住“不回退到 EDP 邮箱”。

### 7.3 验证并提交

运行 API 生命周期、EDP 回执 1–5 次和 AliMail 批处理回归测试。提交信息：

```text
feat: lock EDP reviews to annual rules
```

## Task 8：严格保留两张工作表并写入新审核意见

**修改文件**

- 修改：`worker/edp-review-workbook.ts`
- 修改：`tests/rendered-html.test.mjs`

### 8.1 先写失败测试

用模板副本生成草稿和正式 Excel，断言：

- 工作表名称和数量严格为两张。
- 首页字段问题、规则文件名、规则版本写入第一页合适的已有意见区域。
- 详细审核项按既有最接近模板行写入第二页意见列，同一行多条意见按页码分点汇总。
- 每条意见保留来源页码和短证据，模板标题、合并单元格和样式不被覆盖。
- 草稿允许 blocking needs_human 与非阻塞 deferred。
- 正式导出只被 blocking needs_human 阻止；照片 deferred 不阻止。
- 重新审核导出保存新版本，旧导出的规则版本不变。

执行：

```powershell
node --test --test-name-pattern "EDP workbook writes annual detailed audit" tests/rendered-html.test.mjs
```

预期：工作簿缺少新版本和意见内容或正式导出语义不符。

### 8.2 实现工作簿映射

- 首页问题汇总到 `1) EDP Cover Page` 的既有审核意见位置，不新建单元格结构或第三张表。
- 新审核规则为每组定义稳定模板行映射；同一行先按页码、规则 ID 排序再生成项目符号。
- 正式导出判断改为“存在阻塞 needs_human”而不是“存在任意 needs_human”。
- 导出记录继续保存任务 rule_version 和 template_version。

### 8.3 验证并提交

运行工作簿、模板样式和 API 导出测试。提交信息：

```text
feat: export detailed EDP audit evidence
```

## Task 9：增加年度规则卡片与分组审核界面

**修改文件**

- 修改：`app/collector-dashboard.tsx`
- 修改：`app/globals.css`（仅当现有组件样式无法满足时）
- 修改：`tests/rendered-html.test.mjs`

### 9.1 先写失败测试

在服务端渲染和构建后的真实页面行为测试中断言：

- EDP 审核区卡片顺序为“年度竞赛规则 → 审核意见表设置 → 最新审核任务”。
- 年度规则卡片有年份、PDF 选择、上传、状态、检测年份、冲突提示、候选事实数量、变化摘要、启用、下载、删除/归档操作。
- 冲突版本的启用先显示明确确认；不能由普通点击静默激活。
- 审核详情按首页、工作安全评估、SOP、历年方案、其他规则分组。
- 每项显示状态、阻塞标签、规则来源、文件、页码、摘录和意见；照片显示“暂缓审核/不阻塞”。
- 审核任务可点击“按当前启用规则重新审核”。
- 界面保持现有中文加粗可读风格，移动端按钮可换行且不产生水平溢出。

执行：

```powershell
node --test --test-name-pattern "renders annual EDP rule and grouped review UI" tests/rendered-html.test.mjs
```

预期：页面缺少年度规则卡片和分组详情。

### 9.2 实现界面状态与操作

增加明确类型：

- `RuleDocumentSummary`
- `RuleDocumentDetail`
- `RuleFactView`
- 扩展 `EdpReviewItemView` 的 `isBlocking`、`ruleSource`。

页面进入 EDP 审核栏目时加载规则列表和审核任务；上传与启用后仅刷新相关数据，不刷新凡科或阿里邮箱页面。文件操作显示进行中状态和中文成功/失败提示。删除和冲突激活使用现有确认对话框模式。

### 9.3 验证并提交

运行 UI 定向测试、构建和现有控制台渲染测试。提交信息：

```text
feat: add annual rules to EDP audit workspace
```

## Task 10：综合回归、迁移审计与站点版本保存

**检查文件**

- `README.md`
- `docs/superpowers/specs/2026-09-02-edp-annual-rules-and-detailed-audit-design.md`
- `drizzle/0016_edp_annual_rules.sql`
- 所有本次修改文件

### 10.1 完整验证

依次执行并保留新鲜结果：

```powershell
npm test
npm run lint
npm run build
git diff --check
git status --short
```

额外审计：

- 搜索 `TODO|FIXME|placeholder`，确认生产实现不存在占位逻辑。
- 检查所有新增写 API 均位于现有共享登录和同源保护之后。
- 检查 R2 删除路径不允许删除 active、archived 或已引用规则。
- 检查数据库激活逻辑始终在同一 D1 batch 内归档旧版本并启用新版本。
- 检查 EDP 首页邮箱没有进入任何 `recipient` 赋值路径。
- 检查生成工作簿恰好两张工作表。

### 10.2 文档与提交

更新 README 的操作者说明：年度规则如何上传、查看冲突、确认启用、下载、归档，以及“新规则不改写历史审核”“不自动发邮件”。提交信息：

```text
docs: explain annual EDP rule workflow
```

### 10.3 保存站点版本但不公开部署

按 Sites 保存流程创建新的站点版本，记录版本号与预览状态。只有在向用户汇报全部验证结果并取得明确“公开发布该版本”后，才执行公开发布。

## 风险控制与回退

- 若未来规则 PDF 的版式无法可靠抽取，状态保持 failed 或 needs_confirmation，当前 active 版本不变。
- 若中文/英文语义无法通过客观字段验证，输出 needs_human，不以词数或模糊相似度自动否决。
- 若数据库迁移已应用但新功能暂未启用，新增列默认值保证旧任务继续运行。
- 若新审核引擎异常，单任务进入 failed 并保留错误，不删除原 EDP 压缩包和历史 Excel。
- 任何单校邮件收件人缺失只影响该校草稿，批处理继续；系统绝不自动发送邮件。
