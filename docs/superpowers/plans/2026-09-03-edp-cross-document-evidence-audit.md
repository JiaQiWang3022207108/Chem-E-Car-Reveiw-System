# EDP Cross-Document Evidence Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task, `test-driven-development` for each behavior, and `verification-before-completion` before claiming completion.

**Goal:** Add conservative PDF visual evidence and cross-document EDP checks while exempting the four English-only sections from Chinese-template completeness checks.

**Architecture:** Extend PDF extraction with per-page signals, keep deterministic audit rules in a focused cross-document module, merge its stable rule IDs into the existing review engine, and reuse the current two-sheet workbook writer and review UI.

**Tech Stack:** TypeScript, Cloudflare Worker, pdfjs-dist, ExcelJS, React/Next-compatible client, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-03-edp-cross-document-evidence-audit-design.md`

## Global Constraints

- [ ] Never fail Chinese EDP for missing Hazards Analysis, Laboratory Floor Plan, Vehicle Primary Hazards Checklist, or Chemical Information Page.
- [ ] Never equate an image/path count with a verified signature or checked box.
- [ ] Keep exactly the two existing workbook sheets.
- [ ] Keep all user PDFs local to the existing storage path; do not call an external AI API.
- [ ] Do not deploy publicly in this phase.

## Task 1: Capture PDF Page Evidence Signals

**Files:** `worker/edp-review-engine.ts`, `tests/rendered-html.test.mjs`

- [ ] Add a failing test for stable image, annotation, and path counts.
- [ ] Add optional `pageSignals` to `EdpReviewDocument` for backward compatibility.
- [ ] Extract operator-list and display-annotation signals page by page.
- [ ] Keep corrupt/low-text behavior unchanged and rerun focused tests.

## Task 2: Encode Chinese Template Exemptions and Shared-Section Comparison

**Files:** `worker/edp-detailed-audit.ts`, `worker/edp-cross-document-audit.ts`, `tests/rendered-html.test.mjs`

- [ ] Write a failing test where English contains all four exclusive chapters and Chinese omits them without an error.
- [ ] Write a failing test where a genuinely shared section is absent or objectively contradictory.
- [ ] Implement explicit shared and English-only section registries.
- [ ] Restrict bilingual comparison to shared sections and preserve page evidence.

## Task 3: Add Signatures and English-Only Safety Checks

**Files:** `worker/edp-cross-document-audit.ts`, `worker/edp-review-rules.ts`, `tests/rendered-html.test.mjs`

- [ ] Test handwritten-signature evidence, optional external-expert signature, and missing required MOC signature.
- [ ] Test English Hazards Analysis and Laboratory Floor Plan without touching Chinese completeness.
- [ ] Test checklist ambiguity and contradiction with later hazard text.
- [ ] Implement conservative yes/no/needs_human decisions and stable rule IDs.

## Task 4: Add Chemical, SDS, Training, and Equipment Cross-Checks

**Files:** `worker/edp-cross-document-audit.ts`, `worker/edp-review-engine.ts`, `tests/rendered-html.test.mjs`

- [ ] Test a clearly used chemical missing from Chemical Information/SDS.
- [ ] Test ordinary water exemption and ambiguous synonym escalation.
- [ ] Test roster-to-training-certificate coverage for students and faculty advisor.
- [ ] Test equipment manufacturer/limit/specification coverage.
- [ ] Merge strict results by rule ID without duplicate database keys.

## Task 5: Add Applicability, Capital Cost, Waste, and MOC Checks

**Files:** `worker/edp-cross-document-audit.ts`, `worker/edp-review-engine.ts`, `tests/rendered-html.test.mjs`

- [ ] Test hydrogen and pressure calculations as explicit not_applicable versus required-but-empty.
- [ ] Test complete and arithmetically inconsistent capital-cost tables.
- [ ] Test waste-table streams against Team Waste Tags.
- [ ] Test substantive MOC content and required-signature evidence for submissions 2–5.

## Task 6: Integrate Review UI and Two-Sheet Workbook

**Files:** `app/collector-dashboard.tsx`, `worker/edp-review-workbook.ts`, `tests/rendered-html.test.mjs`

- [ ] Add labels and groups for every new stable rule ID.
- [ ] Show evidence filename, page, excerpt, and visual-evidence caveat.
- [ ] Map new checks to the closest existing evaluation rows and combine multiple comments deterministically.
- [ ] Assert generated workbook contains exactly `1) EDP Cover Page` and `2) EDP Evaluation`.

## Task 7: Validate with Synthetic Fixtures and the Tianjin Sample

**Files:** `tests/rendered-html.test.mjs`, no committed user PDF fixtures

- [ ] Run focused tests after each implementation task.
- [ ] Run a local one-off audit against the provided Tianjin four-file archive.
- [ ] Confirm the Chinese exemption and expected chemical, checklist, waste, certificate, and MOC findings.
- [ ] Do not hard-code Tianjin-specific conclusions in production rules.

## Task 8: Full Verification and Local Handoff

- [ ] Run `npm test`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and inspect `git status --short`.
- [ ] Check no user sample PDFs or temporary extraction artifacts are committed.
- [ ] Save/open the local ChatGPT/Codex preview only; do not publish a public site version.
