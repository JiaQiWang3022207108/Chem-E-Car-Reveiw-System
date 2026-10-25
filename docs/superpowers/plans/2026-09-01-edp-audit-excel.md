# EDP Audit And Excel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every latest qualified EDP with strict evidence rules, expose human confirmation, and generate one preserved two-sheet Excel workbook per school.

**Architecture:** Add versioned review jobs and item results around existing EDP submissions. Extract PDF text from the stored ZIP, resolve only high-confidence rules, mark all uncertainty for human confirmation, and patch an immutable OpenXML template without changing its formatting.

**Tech Stack:** TypeScript, Cloudflare Worker/D1/R2, JSZip, pdfjs-dist, React 19, Node test runner, artifact-tool for local workbook verification.

**Spec:** `docs/superpowers/specs/2026-09-01-edp-audit-and-alimail-media-design.md`

## Global Constraints

- Only the latest qualified EDP for a school creates an active review.
- Collection receipts remain independent from audit opinions.
- Status is exactly `yes`, `no`, `not_applicable`, or `needs_human`.
- Keyword absence alone cannot produce `no`.
- Draft Excel may contain “待人工确认”; formal Excel may not be generated while unresolved items remain.
- The source workbook is never modified and generated workbooks preserve both sheet names and merge ranges.
- Reviewer names are display text only; the system never fabricates a handwritten signature.
- Rule, template, submission, and export versions are recorded.
- All behavior changes use a failing test first.

---

## File Structure

- Copy `第x次EDP审核意见__xx大学.xlsx` to immutable asset `public/edp-review-template-v1.xlsx`.
- Create `worker/edp-review-rules.ts`: 32 rule definitions and conservative evidence resolution.
- Create `worker/edp-review-engine.ts`: ZIP/PDF role detection, text extraction, evidence, and overall result.
- Create `worker/edp-review-workbook.ts`: OpenXML cell patching and workbook generation.
- Create `worker/edp-review-api.ts`: settings, jobs, item confirmation, rerun, and export endpoints.
- Modify `worker/index.ts`: route APIs and include review summary in dashboard data.
- Modify `db/schema.ts`: review settings, jobs, items, and exports.
- Create `drizzle/0015_edp_reviews.sql`: data-preserving migration.
- Modify `app/collector-dashboard.tsx`: new EDP audit navigation/workspace/dialogs.
- Modify `app/globals.css`: review list, evidence drawer, strict status styles.
- Modify `tests/rendered-html.test.mjs`: engine, migration, lifecycle, API, UI, and workbook tests.

### Task 1: Freeze and verify the two-sheet template

**Files:**
- Create: `public/edp-review-template-v1.xlsx`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `C:/Users/Lenovo/Documents/ChatGPT-Codex/codex1/第x次EDP审核意见__xx大学.xlsx` read-only.
- Produces: immutable template asset and `EDP_REVIEW_TEMPLATE_VERSION = "v1"`.

- [ ] **Step 1: Write a failing template contract test**

```js
test("EDP audit template keeps both sheets and required merge ranges", async () => {
  const bytes = await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url));
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await zip.file("xl/workbook.xml").async("text");
  assert.match(workbookXml, /1\) EDP Cover Page/);
  assert.match(workbookXml, /2\) EDP Evaluation/);
  const coverXml = await zip.file("xl/worksheets/sheet1.xml").async("text");
  assert.match(coverXml, /mergeCell ref="C13:E13"/);
});
```

- [ ] **Step 2: Run the test and verify the missing asset failure**

Run: `node --test --test-name-pattern "EDP audit template keeps" tests/rendered-html.test.mjs`  
Expected: FAIL with file not found.

- [ ] **Step 3: Copy the template without changing the source**

Use a binary-safe copy from the user file to `public/edp-review-template-v1.xlsx`. Record and compare SHA-256 hashes of source and copied asset; they must match.

- [ ] **Step 4: Run the template test**

Run: `node --test --test-name-pattern "EDP audit template keeps" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit the immutable template**

```bash
git add public/edp-review-template-v1.xlsx tests/rendered-html.test.mjs
git commit -m "add immutable EDP review template"
```

### Task 2: Add review persistence and lifecycle states

**Files:**
- Modify: `db/schema.ts`
- Create: `drizzle/0015_edp_reviews.sql`
- Modify: `drizzle/meta/_journal.json`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces `edp_review_settings`, `edp_review_jobs`, `edp_review_items`, and `edp_review_exports` with the exact keys from the approved spec.

- [ ] **Step 1: Write failing migration tests**

Apply migrations through 0014, insert a qualified EDP row, apply 0015, and assert the original row remains. Assert D1 rejects an item status outside the four allowed values.

- [ ] **Step 2: Run the migration test**

Run: `node --test --test-name-pattern "0015 EDP review migration" tests/rendered-html.test.mjs`  
Expected: FAIL because migration 0015 is absent.

- [ ] **Step 3: Create constrained tables**

```sql
CREATE TABLE `edp_review_jobs` (
  `user_id` text NOT NULL,
  `job_id` text NOT NULL,
  `school_key` text NOT NULL,
  `school_name` text NOT NULL,
  `submission_id` text NOT NULL,
  `submitted_at` text NOT NULL,
  `submission_round` integer NOT NULL CHECK (`submission_round` BETWEEN 1 AND 5),
  `rule_version` text NOT NULL,
  `template_version` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('queued','processing','needs_human','ready','completed','failed','superseded')),
  `overall_status` text NOT NULL CHECK (`overall_status` IN ('pending','passed','failed','needs_human')),
  `superseded_by` text,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`user_id`,`job_id`)
);
```

Add settings, items, exports, foreign-key-compatible indexes, and unique active submission identifiers as specified.

- [ ] **Step 4: Run migration tests**

Run: `node --test --test-name-pattern "0015 EDP review migration" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit schema and migration**

```bash
git add db/schema.ts drizzle/0015_edp_reviews.sql drizzle/meta/_journal.json tests/rendered-html.test.mjs
git commit -m "add EDP review persistence"
```

### Task 3: Define all checklist rules and strict resolution

**Files:**
- Create: `worker/edp-review-rules.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces:
  - `type EdpReviewStatus = "yes" | "no" | "not_applicable" | "needs_human"`
  - `interface EdpReviewEvidence { documentRole; filename; page; excerpt; }`
  - `interface EdpReviewRule { id; row; documentRoles; positivePatterns; negativePatterns; notApplicablePatterns; autoResolve; }`
  - `const EDP_REVIEW_RULES: readonly EdpReviewRule[]`
  - `resolveEdpReviewRule(rule, documents): EdpReviewRuleResult`

- [ ] **Step 1: Write failing strictness tests**

Test that clear positive evidence can resolve an enabled rule to `yes`, explicit “not applicable/no pressure system” can resolve a pressure rule to `not_applicable`, missing keywords remain `needs_human`, and conflicting evidence remains `needs_human`.

- [ ] **Step 2: Run targeted rule tests**

Run: `node --test --test-name-pattern "EDP strict review rules" tests/rendered-html.test.mjs`  
Expected: FAIL because the rule module is absent.

- [ ] **Step 3: Define the complete 32-row identity map**

```ts
export const EDP_REVIEW_RULE_ROWS = Object.freeze({
  chemical_sds: 5, ppe: 6, reactions_overview: 8, onsite_hydrogen: 9,
  operating_principle: 10, vehicle_photo: 11, syringes_fixed: 12,
  secondary_containment: 13, component_specs: 15, commercial_component_docs: 16,
  pressure_vessel_certificate: 18, no_plastic_pressure: 19, mawp_gt_mop: 20,
  plastic_pressure_test_docs: 21, pressure_relief_device: 22,
  unknown_mawp_external_cert: 23, instructor_signed_relief_basis: 24,
  relief_sizing: 25, relief_test: 26, max_pressure_500psig: 27,
  hazard_types: 29, jsa: 30, safeguards: 31, rule_violations: 32,
  moc: 34, aisle: 36, emergency_equipment: 37, sop: 39,
  chemical_waste_sop: 40, post_competition_cleanup: 41,
  certification_signatures: 43, ten_hours_experience: 44,
} as const);
```

- [ ] **Step 4: Implement conservative resolution**

Only rules with unambiguous textual evidence start with `autoResolve: true`. All others still gather evidence but return `needs_human`. A rule can never return `no` solely because no pattern matched.

- [ ] **Step 5: Run rule tests**

Run: `node --test --test-name-pattern "EDP strict review rules" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit the rule registry**

```bash
git add worker/edp-review-rules.ts tests/rendered-html.test.mjs
git commit -m "define strict EDP review rules"
```

### Task 4: Extract EDP documents and build evidence results

**Files:**
- Create: `worker/edp-review-engine.ts`
- Modify: `worker/index.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: qualified `edp_submissions` R2 ZIP and `EDP_REVIEW_RULES`.
- Produces:
  - `auditEdpArchive(bytes, context): Promise<EdpAuditResult>`
  - `extractPdfReviewDocument(filename, bytes, role): Promise<EdpReviewDocument>`
  - `computeOverallReviewStatus(items): "passed" | "failed" | "needs_human"`

- [ ] **Step 1: Write failing archive and overall-status tests**

Create in-memory ZIP fixtures for a text PDF set, a scanned/empty-text PDF, conflicting evidence, and round 2 without MOC. Assert empty text yields `needs_human`, any `no` yields failed, and unresolved items prevent passed.

- [ ] **Step 2: Run engine tests**

Run: `node --test --test-name-pattern "EDP audit engine" tests/rendered-html.test.mjs`  
Expected: FAIL because the engine is absent.

- [ ] **Step 3: Implement safe ZIP and dynamic PDF extraction**

Limit entry count, per-entry bytes, and total decompressed bytes. Dynamically import `pdfjs-dist` inside the extraction function to avoid SSR startup failures. Store page-separated text and evidence excerpts capped at 240 characters.

- [ ] **Step 4: Implement role assignment and strict overall status**

Use filename plus document text to identify Chinese EDP, English EDP, supplement, and MOC. Ambiguous roles create a job error or `needs_human`; they never silently swap documents.

- [ ] **Step 5: Run engine tests**

Run: `node --test --test-name-pattern "EDP audit engine" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit the audit engine**

```bash
git add worker/edp-review-engine.ts worker/index.ts tests/rendered-html.test.mjs
git commit -m "audit EDP archives with evidence"
```

### Task 5: Add review job API and superseding behavior

**Files:**
- Create: `worker/edp-review-api.ts`
- Modify: `worker/index.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces endpoints:
  - `GET/PUT /api/edp-reviews/settings`
  - `GET /api/edp-reviews`
  - `GET /api/edp-reviews/:jobId`
  - `POST /api/edp-reviews/:jobId/run`
  - `PUT /api/edp-reviews/:jobId/items/:ruleId`
  - `POST /api/edp-reviews/:jobId/finalize`

- [ ] **Step 1: Write failing lifecycle tests**

Assert a qualified EDP creates a queued job, a newer submission supersedes it, rerun changes rule version while preserving prior job history, user overrides are audited, and finalize returns 409 while any item is `needs_human`.

- [ ] **Step 2: Run API tests**

Run: `node --test --test-name-pattern "EDP review API lifecycle" tests/rendered-html.test.mjs`  
Expected: FAIL with missing routes.

- [ ] **Step 3: Implement transactional job writes**

Write jobs and all 32 item rows in D1 batches. Save automatic and final statuses separately so user overrides are never lost on display; a rerun creates a new job or explicitly resets only automatic fields.

- [ ] **Step 4: Trigger jobs without changing receipts**

After a successful EDP upload/collection, enqueue the review. Do not update `edp_issues` or the already generated EDP receipt based on review opinions.

- [ ] **Step 5: Run lifecycle tests**

Run: `node --test --test-name-pattern "EDP review API lifecycle" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit review API**

```bash
git add worker/edp-review-api.ts worker/index.ts tests/rendered-html.test.mjs
git commit -m "add EDP review lifecycle API"
```

### Task 6: Generate preserved two-sheet Excel files

**Files:**
- Create: `worker/edp-review-workbook.ts`
- Modify: `worker/edp-review-api.ts`
- Modify: `worker/index.ts`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces:
  - `buildEdpReviewWorkbook(templateBytes, payload): Promise<Uint8Array>`
  - `reviewStatusLabel(status): "是" | "否" | "不适用" | "待人工确认"`
  - endpoints `POST /api/edp-reviews/:jobId/exports/draft` and `POST /api/edp-reviews/:jobId/exports/final`.

- [ ] **Step 1: Write failing OpenXML mapping tests**

Generate a draft with one `no`, one `needs_human`, and reviewer settings. Reopen with `xlsx` and assert both sheet names, E4 school, C13:E13 summary, B5/D5 status/comment, B6/D6 pending marker, and date value. Inspect ZIP XML to assert original merge refs remain.

- [ ] **Step 2: Run workbook tests**

Run: `node --test --test-name-pattern "EDP review workbook" tests/rendered-html.test.mjs`  
Expected: FAIL because the generator is absent.

- [ ] **Step 3: Implement XML patching without rebuilding workbook styles**

Use JSZip to copy the template package, clear all variable cells, write inline strings to the exact mapped cells, write the date as an Excel serial with the existing date style, and leave all unrelated XML untouched.

- [ ] **Step 4: Store exports and enforce draft/final rules**

Save bytes to R2 under a versioned job key. Draft filenames end `__草稿.xlsx`. Return 409 from the final endpoint when unresolved items remain. Deleting an export removes only its object/row; regeneration recreates it.

- [ ] **Step 5: Run workbook and API tests**

Run: `node --test --test-name-pattern "EDP review workbook|EDP review export" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit workbook generation**

```bash
git add worker/edp-review-workbook.ts worker/edp-review-api.ts worker/index.ts tests/rendered-html.test.mjs
git commit -m "generate per-school EDP review workbooks"
```

### Task 7: Build the EDP audit workspace

**Files:**
- Modify: `app/collector-dashboard.tsx`
- Modify: `app/globals.css`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: review list/detail/settings/run/item/export APIs.
- Produces: navigation item `EDP 审核`, sortable job list, evidence dialog, strict status controls, draft/final download actions.

- [ ] **Step 1: Write failing UI tests**

Assert the dashboard contains an independent EDP audit workspace, keeps receipt controls only on the EDP submission page, displays four status labels, shows evidence/page references, supports “按最新规则重新审核”, and disables final export for pending items.

- [ ] **Step 2: Run targeted UI tests**

Run: `node --test --test-name-pattern "EDP audit workspace" tests/rendered-html.test.mjs`  
Expected: FAIL because the workspace is absent.

- [ ] **Step 3: Add focused React components**

Create local components within the existing dashboard file unless extraction is necessary to stay readable: `EdpReviewSettingsCard`, `EdpReviewJobList`, `EdpReviewItemDialog`, and `EdpReviewExportActions`.

- [ ] **Step 4: Enforce strict user interaction**

Require a comment when changing a result to `no` or `not_applicable`; show automatic evidence separately from the final user decision; confirm before finalizing. Sorting uses Chinese school collation and preserves distinct campuses.

- [ ] **Step 5: Run UI tests**

Run: `node --test --test-name-pattern "EDP audit workspace" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit the audit workspace**

```bash
git add app/collector-dashboard.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "add strict EDP audit workspace"
```

### Task 8: Verify workbook visuals and the full audit phase

**Files:**
- Create/update only temporary verification scripts under `work/`; do not commit them.

**Interfaces:**
- Consumes: generated draft and final XLSX fixtures.
- Produces: verified exports with no formula errors, clipped content, lost merge cells, or missing sheet.

- [ ] **Step 1: Generate representative draft and final files**

Use the actual runtime generator with a pass case, a failed case, and a pending case.

- [ ] **Step 2: Inspect with artifact-tool**

Inspect both sheets' key ranges, scan for `#REF!|#DIV/0!|#VALUE!|#NAME?|#N/A`, and render both sheets for every representative workbook.

- [ ] **Step 3: Visually review both rendered sheets**

Confirm statuses/comments are visible, old Tianjin/reviewer example values are gone, long comments are readable, and no fixed checklist text was overwritten.

- [ ] **Step 4: Run full project checks**

Run: `npm test`  
Expected: all tests and production build pass.

Run: `npx eslint app/collector-dashboard.tsx worker/edp-review-rules.ts worker/edp-review-engine.ts worker/edp-review-workbook.ts worker/edp-review-api.ts worker/index.ts db/schema.ts`  
Expected: exit 0.

Run: `git diff --check`  
Expected: no whitespace errors.

- [ ] **Step 5: Commit verification-driven fixes, if any**

```bash
git add app worker db drizzle tests public/edp-review-template-v1.xlsx
git commit -m "verify EDP review and Excel output"
```

