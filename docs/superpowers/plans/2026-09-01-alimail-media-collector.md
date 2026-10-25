# AliMail Media Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove poster/video collection from Fanke and collect those attachments from an already logged-in AliMail browser session into the existing shared cloud libraries.

**Architecture:** Keep Fanke limited to registration and EDP. Add a dedicated AliMail inbox collector content script and browser scan APIs that reuse the existing media settings, candidate queue, 8MB multipart upload, R2 storage, latest-per-school behavior, and deletion semantics.

**Tech Stack:** React 19, TypeScript, Cloudflare Worker/D1/R2, Chrome Manifest V3, JavaScript content scripts, JSZip, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-01-edp-audit-and-alimail-media-design.md`

## Global Constraints

- Fanke continues to collect only `registration` and `edp`.
- Poster formats are AI/JPG/JPEG/ZIP/7z/RAR; video formats are MP4/ZIP/7z/RAR.
- Poster and video files remain limited to 209715200 bytes and upload in 8MB parts.
- The helper reads but never sends, deletes, moves, or marks AliMail messages.
- Browser collection pauses when the browser/login session is unavailable and resumes from the stored checkpoint.
- Ambiguous media type or school goes to the existing candidate queue; it is never auto-filed.
- A previously seen attachment must be downloaded again when its shared asset was deleted.
- All behavior changes use a failing test before production code.

---

## File Structure

- Create `worker/browser-mail-media.ts`: pure classification, scan validation, checkpoints, metadata ingestion, and shared-object existence checks.
- Create `fanke-helper/alimail-collector.js`: AliMail inbox/page adapter and attachment reader.
- Modify `fanke-helper/background.js`: find/login-probe AliMail, schedule scans, route chunks and progress.
- Modify `fanke-helper/site-bridge.js`: bridge authenticated site API requests and scan events.
- Modify `fanke-helper/manifest.json`: register collector script and bump helper version.
- Modify `worker/index.ts`: route browser media scan APIs and expose scan state on the dashboard.
- Modify `db/schema.ts`: add browser scan checkpoints and seen attachments.
- Create `drizzle/0014_browser_mail_media.sql`: data-preserving D1 migration.
- Modify `app/collector-dashboard.tsx`: remove media Fanke controls and add compact AliMail scan controls.
- Modify `tests/rendered-html.test.mjs`: pure, API, UI, migration, and helper regression tests.
- Modify `fanke-helper/安装说明.txt` and regenerate `public/chemecar-fanke-helper.zip` after tests pass.

### Task 1: Lock Fanke to registration and EDP

**Files:**
- Modify: `app/collector-dashboard.tsx`
- Modify: `fanke-helper/fanke-scraper.js`
- Modify: `fanke-helper/background.js`
- Modify: `worker/fanke-collector.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: existing `FankeControls`, `startFankeAssistantScan`, and helper `FANKE_HELPER_START` message.
- Produces: `type FankeCollectibleKind = "registration" | "edp"` enforced at UI, helper, and API boundaries.

- [ ] **Step 1: Write the failing boundary tests**

```js
test("Fanke helper and media workspaces only expose registration and EDP", async () => {
  const dashboard = await readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8");
  const helper = await readFile(new URL("../fanke-helper/fanke-scraper.js", import.meta.url), "utf8");
  assert.doesNotMatch(dashboard, /<FankeControls[^>]+kind=\{activeMediaKind\}/);
  assert.match(helper, /\["registration",\s*"edp"\]\.includes\(message\.targetKind\)/);
});
```

- [ ] **Step 2: Run the test and verify the old media path fails it**

Run: `node --test --test-name-pattern "Fanke helper and media workspaces" tests/rendered-html.test.mjs`  
Expected: FAIL because poster/video still render `FankeControls` and are accepted by the helper.

- [ ] **Step 3: Narrow the type and validation at every entry point**

```ts
export type FankeCollectibleKind = "registration" | "edp";

export function parseFankeCollectibleKind(value: unknown): FankeCollectibleKind | null {
  return value === "registration" || value === "edp" ? value : null;
}
```

Keep old D1 rows/check constraints readable for migration safety, but reject new poster/video assistant scans with a Chinese error directing users to AliMail.

- [ ] **Step 4: Run the targeted test**

Run: `node --test --test-name-pattern "Fanke helper and media workspaces" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit the boundary change**

```bash
git add app/collector-dashboard.tsx fanke-helper/fanke-scraper.js fanke-helper/background.js worker/fanke-collector.ts tests/rendered-html.test.mjs
git commit -m "restrict Fanke collection to registration and EDP"
```

### Task 2: Add browser media scan persistence and classification

**Files:**
- Create: `worker/browser-mail-media.ts`
- Modify: `db/schema.ts`
- Create: `drizzle/0014_browser_mail_media.sql`
- Modify: `drizzle/meta/_journal.json`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `shared_media_assets`, `mail_media_candidates`, and `media_collector_settings`.
- Produces:
  - `type BrowserMailMediaKind = "poster" | "video"`
  - `classifyBrowserMailAttachment(input: BrowserMailAttachmentInput): BrowserMailClassification`
  - `ingestBrowserMailBatch(request, env, userId): Promise<Response>`
  - `getBrowserMailScanState(env, userId): Promise<BrowserMailScanState>`
  - `sharedMediaObjectExists(env, userId, kind, fingerprint): Promise<boolean>`

- [ ] **Step 1: Write failing classifier and migration tests**

```js
test("browser AliMail classification is conservative for archives", async () => {
  const mod = compile(browserMailSource, "browser-mail-media.ts")({});
  assert.equal(mod.classifyBrowserMailAttachment({ filename: "天津大学-海报.zip", subject: "作品资料", contentType: "application/zip" }).kind, "poster");
  assert.equal(mod.classifyBrowserMailAttachment({ filename: "天津大学.zip", subject: "作品资料", contentType: "application/zip" }).kind, null);
  assert.equal(mod.classifyBrowserMailAttachment({ filename: "天津大学-宣传视频.mp4", subject: "视频提交", contentType: "video/mp4" }).kind, "video");
});
```

Apply migration `0014_browser_mail_media.sql` to an in-memory D1 database and assert that existing `shared_media_assets` rows survive.

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `node --test --test-name-pattern "browser AliMail classification|0014 browser mail" tests/rendered-html.test.mjs`  
Expected: FAIL because the module and tables do not exist.

- [ ] **Step 3: Define exact storage tables**

```sql
CREATE TABLE `browser_mail_scan_checkpoints` (
  `user_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('poster','video')),
  `mailbox_key` text NOT NULL DEFAULT '',
  `last_message_key` text,
  `last_scan_at` text,
  `last_error` text,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`,`kind`)
);

CREATE TABLE `browser_mail_seen_attachments` (
  `user_id` text NOT NULL,
  `fingerprint` text NOT NULL,
  `kind` text CHECK (`kind` IS NULL OR `kind` IN ('poster','video')),
  `school_name` text,
  `filename` text NOT NULL,
  `size` integer NOT NULL,
  `received_at` text NOT NULL,
  `source_ref` text NOT NULL,
  `asset_school_key` text,
  `status` text NOT NULL CHECK (`status` IN ('pending','uploaded','candidate','missing','invalid')),
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`,`fingerprint`)
);
```

- [ ] **Step 4: Implement conservative pure classification**

```ts
export interface BrowserMailAttachmentInput {
  filename: string;
  subject: string;
  contentType: string;
  surroundingText?: string;
}

export interface BrowserMailClassification {
  kind: BrowserMailMediaKind | null;
  reason: string;
}
```

AI/JPG/JPEG is poster, MP4 is video, and archives require an explicit poster/video hint in filename, subject, or surrounding text.

- [ ] **Step 5: Run targeted tests**

Run: `node --test --test-name-pattern "browser AliMail classification|0014 browser mail" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit persistence and classifier**

```bash
git add worker/browser-mail-media.ts db/schema.ts drizzle/0014_browser_mail_media.sql drizzle/meta/_journal.json tests/rendered-html.test.mjs
git commit -m "add browser AliMail media scan state"
```

### Task 3: Add authenticated browser scan APIs

**Files:**
- Modify: `worker/browser-mail-media.ts`
- Modify: `worker/index.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: existing login session, `normalizeSchoolName`, media multipart endpoints, R2 binding.
- Produces endpoints:
  - `POST /api/mail-browser/scans/start`
  - `POST /api/mail-browser/scans/batch`
  - `POST /api/mail-browser/scans/finish`
  - `POST /api/mail-browser/assets/exists`
  - `GET /api/mail-browser/state`

- [ ] **Step 1: Write failing authenticated API tests**

Test a valid batch, an archive with ambiguous type, a date-before-cutoff record, a 200MB+ record, a duplicate whose object exists, and a duplicate whose object was deleted.

```js
assert.equal((await worker.fetch(authenticatedRequest("/api/mail-browser/scans/batch", batch))).status, 200);
assert.equal(fakeDb.candidates.length, 1);
assert.equal(fakeDb.uploadQueue.length, 1);
```

- [ ] **Step 2: Run tests and verify route-not-found failure**

Run: `node --test --test-name-pattern "browser mail scan API" tests/rendered-html.test.mjs`  
Expected: FAIL with 404 or an unrecognized route.

- [ ] **Step 3: Implement validation and idempotency**

Use a maximum of 50 messages and 100 attachments per batch, validate ISO timestamps, clamp text fields, reject unsupported formats, and check each kind's saved start date. Return one result per attachment:

```ts
type BrowserMailBatchResult = {
  fingerprint: string;
  action: "upload" | "skip" | "candidate" | "reject";
  kind: BrowserMailMediaKind | null;
  reason: string;
};
```

For `uploaded` fingerprints, confirm that `shared_media_assets` and the R2 object still exist. Return `upload` when either is missing.

- [ ] **Step 4: Run API tests**

Run: `node --test --test-name-pattern "browser mail scan API" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit API routes**

```bash
git add worker/browser-mail-media.ts worker/index.ts tests/rendered-html.test.mjs
git commit -m "add authenticated browser mail scan API"
```

### Task 4: Implement AliMail automatic navigation and scanning

**Files:**
- Create: `fanke-helper/alimail-collector.js`
- Modify: `fanke-helper/background.js`
- Modify: `fanke-helper/site-bridge.js`
- Modify: `fanke-helper/manifest.json`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: browser scan APIs and existing site/AliMail host permissions.
- Produces helper messages:
  - `CHEMECAR_ALIMAIL_COLLECTOR_PROBE`
  - `CHEMECAR_ALIMAIL_SCAN_START`
  - `CHEMECAR_ALIMAIL_SCAN_PROGRESS`
  - `CHEMECAR_ALIMAIL_SCAN_DONE`
  - `CHEMECAR_ALIMAIL_SCAN_ERROR`

- [ ] **Step 1: Write failing helper contract tests**

Assert the manifest registers `alimail-collector.js`, version is newer than 1.4.6, background searches existing AliMail tabs before opening one, and scan code never calls send/delete/move/mark APIs.

- [ ] **Step 2: Run targeted tests**

Run: `node --test --test-name-pattern "AliMail collector helper" tests/rendered-html.test.mjs`  
Expected: FAIL because the collector script and messages are absent.

- [ ] **Step 3: Implement a page adapter with explicit states**

```js
const collectorState = Object.freeze({
  loggedOut: "logged_out",
  inboxReady: "inbox_ready",
  messageReady: "message_ready",
  unknown: "unknown",
});
```

The adapter must probe login state, navigate to the inbox, wait for stable list rows, paginate, stop at the saved date/message boundary, open attachments only when needed, and return structured metadata. Unknown DOM state produces `unknown` and stops.

- [ ] **Step 4: Stream files through existing 8MB multipart uploads**

Download the selected attachment from the authenticated AliMail page, reject a byte length above 209715200, then send exact `Blob.slice(offset, end)` parts through `site-bridge`. Do not hold more than the attachment blob plus one 8MB upload part.

- [ ] **Step 5: Run helper contract tests**

Run: `node --test --test-name-pattern "AliMail collector helper" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit helper upgrade**

```bash
git add fanke-helper/alimail-collector.js fanke-helper/background.js fanke-helper/site-bridge.js fanke-helper/manifest.json tests/rendered-html.test.mjs
git commit -m "collect media from logged-in AliMail"
```

### Task 5: Replace media Fanke UI with AliMail scan controls

**Files:**
- Modify: `app/collector-dashboard.tsx`
- Modify: `app/globals.css`
- Modify: `worker/index.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `GET /api/mail-browser/state`, saved `media_collector_settings`, and helper scan messages.
- Produces `AliMailMediaControls` with per-kind start date, interval, enabled state, last scan, progress, and “立即扫描”.

- [ ] **Step 1: Write failing rendered UI tests**

Assert poster/video pages contain “阿里邮箱自动收取”, do not contain Fanke controls, show separate start dates/frequencies, and retain manual upload/download/delete/bulk-delete actions.

- [ ] **Step 2: Run targeted UI tests**

Run: `node --test --test-name-pattern "media workspaces use AliMail" tests/rendered-html.test.mjs`  
Expected: FAIL because media pages still render Fanke controls.

- [ ] **Step 3: Add the focused control component**

```tsx
<AliMailMediaControls
  kind={activeMediaKind}
  label={mediaLabel}
  schedule={activeMediaSchedule}
  state={browserMailState[activeMediaKind]}
  onSave={saveMediaSchedule}
  onScanNow={startAliMailMediaScan}
/>
```

Show “浏览器关闭后暂停；重新登录后继续” once in a collapsible help row, not in every card.

- [ ] **Step 4: Run targeted UI tests**

Run: `node --test --test-name-pattern "media workspaces use AliMail" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit UI replacement**

```bash
git add app/collector-dashboard.tsx app/globals.css worker/index.ts tests/rendered-html.test.mjs
git commit -m "connect media workspaces to AliMail"
```

### Task 6: Package and verify the collector phase

**Files:**
- Modify: `fanke-helper/安装说明.txt`
- Update: `public/chemecar-fanke-helper.zip`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: completed helper sources and site UI.
- Produces: a downloadable helper ZIP whose manifest version matches the dashboard requirement.

- [ ] **Step 1: Update installation and behavior documentation**

Document that Fanke is for registration/EDP, AliMail is for poster/video, both pages only need to be logged in, scanning pauses with the browser, and original emails are unchanged.

- [ ] **Step 2: Build the helper ZIP from the helper directory**

Run the existing packaging path or a deterministic archive command that includes only `manifest.json`, `background.js`, `site-bridge.js`, `fanke-scraper.js`, `alimail-draft.js`, `alimail-collector.js`, and `安装说明.txt`.

- [ ] **Step 3: Run focused and full verification**

Run: `npm test`  
Expected: all tests pass and the production build exits 0.

Run: `npx eslint app/collector-dashboard.tsx worker/browser-mail-media.ts worker/index.ts`  
Expected: exit 0.

Run: `git diff --check`  
Expected: no whitespace errors.

- [ ] **Step 4: Commit the packaged phase**

```bash
git add fanke-helper/安装说明.txt public/chemecar-fanke-helper.zip
git commit -m "package AliMail media collector helper"
```

