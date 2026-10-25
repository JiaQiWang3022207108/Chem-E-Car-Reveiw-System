// The worker module is imported for registration only; no untyped exports.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {}

declare module "pdfjs-dist/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
