# Console Simplification And Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the completed control console into a calmer, clearer, responsive six-workspace interface and prepare a verified releasable version.

**Architecture:** Preserve the existing single-dashboard application and shared auth, but remove repeated explanatory cards, move advanced details into disclosures, apply one consistent palette and spacing system, and keep each workspace focused on one job.

**Tech Stack:** React 19, CSS, TypeScript, vinext/Vite, Node test runner, Chrome extension package, OpenAI Sites deployment workflow.

**Spec:** `docs/superpowers/specs/2026-09-01-edp-audit-and-alimail-media-design.md`

## Global Constraints

- Navigation order is Registration, EDP Submission, EDP Audit, AliMail Connection, Poster, Video.
- Large readable typography and touch targets remain; status does not rely on color alone.
- Only one visually primary action appears per functional card.
- Repeated shared-mode/rules/storage guidance is consolidated into one collapsible help row.
- Existing shared files, settings, passwords, receipts, and delete/download actions remain available.
- Public deployment requires an exact pushed commit, saved Sites version, and explicit publication approval.
- All behavior changes use a failing test first.

---

## File Structure

- Modify `app/collector-dashboard.tsx`: navigation, workspace headings, disclosures, and content reduction.
- Modify `app/globals.css`: tokens, spacing, cards, buttons, responsive layout, focus and status states.
- Modify `app/layout.tsx`: only if metadata or top-level class needs the new shell name.
- Modify `tests/rendered-html.test.mjs`: information architecture, accessibility, and content regression tests.
- Modify `README.md`, helper installation notes, and any user-facing version labels.

### Task 1: Lock the six-workspace information architecture

**Files:**
- Modify: `app/collector-dashboard.tsx`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: completed registration, EDP submission, EDP audit, AliMail, poster, and video features.
- Produces `type Workspace = "registration" | "edp" | "edp-review" | "mail" | "poster" | "video"` and exact navigation labels/order.

- [ ] **Step 1: Write failing navigation/content tests**

```js
test("console exposes six focused workspaces in order", async () => {
  const dashboard = await readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8");
  const labels = ["报名表统计", "EDP 提交统计", "EDP 审核", "阿里邮箱连接", "海报收集", "视频收集"];
  let cursor = -1;
  for (const label of labels) {
    const next = dashboard.indexOf(label);
    assert.ok(next > cursor, `${label} must follow the previous workspace`);
    cursor = next;
  }
});
```

- [ ] **Step 2: Run the targeted test**

Run: `node --test --test-name-pattern "six focused workspaces" tests/rendered-html.test.mjs`  
Expected: FAIL until EDP audit is in the required order and labels are exact.

- [ ] **Step 3: Implement one-purpose workspace headings**

Keep short title, one-sentence purpose, and only essential metrics. Move raw mail records and technical connection details into `<details>` sections with descriptive `<summary>` labels.

- [ ] **Step 4: Consolidate repeated guidance**

Replace repeated shared-mode, storage, rules, and download explanations with `CollectionHelpDisclosure`, parameterized by workspace. Do not remove download/delete/recollect semantics.

- [ ] **Step 5: Run navigation/content tests**

Run: `node --test --test-name-pattern "six focused workspaces|consolidated collection help" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit information architecture**

```bash
git add app/collector-dashboard.tsx tests/rendered-html.test.mjs
git commit -m "simplify console information architecture"
```

### Task 2: Apply the calm responsive visual system

**Files:**
- Modify: `app/globals.css`
- Modify: `app/collector-dashboard.tsx`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces CSS tokens and component classes for shell, cards, status, disclosures, tables, dialogs, and mobile stacking.

- [ ] **Step 1: Write failing style contract tests**

Assert CSS defines the required token values, visible focus styles, minimum 44px controls, mobile single-column breakpoints, and reduced-motion behavior.

- [ ] **Step 2: Run the style test**

Run: `node --test --test-name-pattern "calm responsive visual system" tests/rendered-html.test.mjs`  
Expected: FAIL because the token system and disclosures are not present.

- [ ] **Step 3: Define exact palette and spacing tokens**

```css
:root {
  --ink-strong: #0b2a4a;
  --ink: #243b53;
  --ink-muted: #627d98;
  --surface: #ffffff;
  --surface-soft: #f6f9fc;
  --surface-blue: #eef5ff;
  --line: #d8e3ef;
  --brand: #2468d8;
  --brand-strong: #164fa8;
  --success: #0f766e;
  --warning: #a15c00;
  --danger: #b42318;
  --radius-card: 18px;
  --control-height: 46px;
}
```

- [ ] **Step 4: Reduce visual noise without shrinking readability**

Use 16px minimum body text, 600 weight for important Chinese labels, lighter secondary copy, subtle one-pixel borders, limited shadows, and consistent card spacing. Preserve black/dark readable text and avoid all-caps English except small metadata labels.

- [ ] **Step 5: Add mobile and accessibility states**

At 900px and below stack grids; at 680px convert side navigation to a compact top/scroll navigation. Add `:focus-visible`, disabled contrast, non-color status labels, `prefers-reduced-motion`, and dialog overflow limits.

- [ ] **Step 6: Run style tests**

Run: `node --test --test-name-pattern "calm responsive visual system" tests/rendered-html.test.mjs`  
Expected: PASS.

- [ ] **Step 7: Commit visual system**

```bash
git add app/globals.css app/collector-dashboard.tsx tests/rendered-html.test.mjs
git commit -m "apply calm responsive console styling"
```

### Task 3: Run end-to-end regression and prepare release artifacts

**Files:**
- Modify: `README.md`
- Modify: `fanke-helper/安装说明.txt`
- Update: `public/chemecar-fanke-helper.zip`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: all completed subsystem commits.
- Produces: tested build, current helper package, and exact source commit ready for Sites versioning.

- [ ] **Step 1: Add cross-feature regression tests**

Cover login, registration/Fanke, EDP/Fanke and receipts, EDP audit/export, AliMail draft writing, AliMail media collection, manual media upload, download/delete/bulk delete, and deleted-file recollection.

- [ ] **Step 2: Run complete local verification**

Run: `npm test`  
Expected: production build succeeds and every test passes.

Run: `npm run lint`  
Expected: exit 0.

Run: `git diff --check`  
Expected: no whitespace errors.

- [ ] **Step 3: Verify package and workbook artifacts**

Open the helper ZIP and assert all required files and the manifest version. Generate and visually inspect representative two-sheet audit workbooks with artifact-tool. Confirm no source workbook change by SHA-256.

- [ ] **Step 4: Update operator documentation**

Document the new source split, browser-open requirement, strict EDP review statuses, draft/formal Excel distinction, shared file location, download/delete/recollect behavior, and no-auto-send/no-email-delete guarantees.

- [ ] **Step 5: Commit release documentation and artifacts**

```bash
git add README.md fanke-helper/安装说明.txt public/chemecar-fanke-helper.zip tests/rendered-html.test.mjs
git commit -m "prepare EDP audit and AliMail media release"
```

### Task 4: Save a production version and request publication approval

**Files:**
- No source edits after the verified commit.

**Interfaces:**
- Consumes: clean committed and pushed HEAD, successful local build archive, existing Sites project ID.
- Produces: saved Sites version and, after explicit approval, a production deployment.

- [ ] **Step 1: Confirm exact clean source state**

Run: `git status --short`  
Expected: no output.

Run: `git rev-parse HEAD`  
Expected: one full commit SHA.

- [ ] **Step 2: Push the exact source commit**

Use the existing Sites source repository credential and push the current branch without embedding or logging credentials.

- [ ] **Step 3: Package the successful local build**

Use the Sites hosting helper to package build output, `.openai/hosting.json`, and all D1 migrations. Verify the archive contains the worker entrypoint and migrations 0014/0015.

- [ ] **Step 4: Save, but do not yet publish, the Sites version**

Save with the exact pushed commit SHA and build archive. Record the opaque version ID and user-facing version number.

- [ ] **Step 5: Ask for explicit publication approval**

Report local verification and saved version number. Publish only after the user explicitly authorizes this version.

- [ ] **Step 6: Deploy and poll to a terminal state after approval**

Deploy the exact saved version, poll until `succeeded` or `failed`, and report the unchanged production URL only on success.

