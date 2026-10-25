import coreModule from "../native/edp_core.wasm?module";

// The browser UI and platform bindings remain TypeScript; actual shared
// validation/aggregation/comparison decisions execute this compiled C++.
const native = new WebAssembly.Instance(coreModule).exports as {
  expected_pdf_count(round: number): number;
  package_issues(round: number, count: number, cn: number, en: number, supplement: number, moc: number, invalid: number): number;
  review_status(failures: number, unknown: number, total: number): number;
  compare_metric(operator: number, actual: number, limit: number): number;
};
export const expectedPdfCount = native.expected_pdf_count;
export const packageIssues = native.package_issues;
export const nativeReviewStatus = native.review_status;
export const compareMetric = native.compare_metric;
