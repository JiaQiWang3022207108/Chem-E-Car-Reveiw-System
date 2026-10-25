import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
// Cloudflare imports .wasm as a compiled Module; Node's default WASM loader
// exposes individual functions instead. Adapt ONLY that host import boundary.
registerHooks({load(url,context,next) {
  if (!url.endsWith(".wasm")) return next(url,context);
  return {format:"module",shortCircuit:true,source:`export default new WebAssembly.Module(Uint8Array.from(${JSON.stringify([...readFileSync(new URL(url))])}));`};
}});
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { Miniflare } from "miniflare";
import ts from "typescript";
import * as XLSX from "xlsx";
// Execute the real checked-in C++ WASM, including in the narrow Node loaders.
const nativeBytes = await readFile(new URL("../native/edp_core.wasm", import.meta.url));
const nativeSource = ts.transpileModule(await readFile(new URL("../worker/native-core.ts", import.meta.url),"utf8"), {
  compilerOptions: {module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023},
}).outputText.replace(/import coreModule from [^;]+;/u,
  `const coreModule = new WebAssembly.Module(Uint8Array.from(${JSON.stringify([...nativeBytes])}));`);
const nativeCoreUrl = `data:text/javascript;base64,${Buffer.from(nativeSource).toString("base64")}`;

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

const testFixedLengthStreams = new WeakSet();
if (!globalThis.FixedLengthStream) {
  globalThis.FixedLengthStream = class TestFixedLengthStream {
    constructor(expectedLength) {
      let actualLength = 0;
      const transform = new TransformStream({
        transform(chunk, controller) {
          actualLength += chunk.byteLength;
          if (actualLength > expectedLength) throw new TypeError("fixed-length stream overflow");
          controller.enqueue(chunk);
        },
        flush() {
          if (actualLength !== expectedLength) throw new TypeError("fixed-length stream underflow");
        },
      });
      this.readable = transform.readable;
      this.writable = transform.writable;
      testFixedLengthStreams.add(this.readable);
    }
  };
}

let workerPromise;
let mailCollectorPromise;
let fileMetadataPromise;
let edpReviewRulesPromise;
let edpReviewEnginePromise;
let edpReviewWorkbookPromise;
let edpRuleParserPromise;
let edpDetailedAuditPromise;
let edpCrossDocumentAuditPromise;
let edpArchiveCorePromise;
let edpPackagePromise;
let certificatePdfPromise;
let pdfRuntimePromise;

function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = readFile(new URL("../worker/pdf-runtime.ts", import.meta.url), "utf8").then((source) => {
      const nonce = `${process.pid}-${Date.now()}`;
      const pdfjsUrl = `${import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")}?workerd-regression=${nonce}`;
      const pdfWorkerUrl = `${import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")}?workerd-regression=${nonce}`;
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: "pdf-runtime.ts",
      }).outputText
        .replaceAll('"pdfjs-dist/legacy/build/pdf.worker.mjs"', JSON.stringify(pdfWorkerUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.worker.mjs'", JSON.stringify(pdfWorkerUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.mjs"', JSON.stringify(pdfjsUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.mjs'", JSON.stringify(pdfjsUrl));
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return pdfRuntimePromise;
}

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

async function loadExtensionScript(relativePath, context) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const sandbox = {
    URL,
    Map,
    Set,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    ...context,
  };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: relativePath });
  return sandbox;
}

function extensionMessageEvent() {
  let listener = null;
  return {
    event: { addListener(value) { listener = value; } },
    dispatch(message, sender = {}) {
      assert.equal(typeof listener, "function", "extension script must register a message listener");
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => {
          if (!settled) reject(new Error(`extension message timed out: ${message.type}`));
        }, 3_000);
        const asynchronous = listener(message, sender, finish);
        if (asynchronous !== true) queueMicrotask(() => finish(undefined));
      });
    },
  };
}

function registrationWorkbookBytes(schoolName, teamName = "测试车队", options = {}) {
  const teacherCount = options.teacherCount ?? 1;
  const studentCount = options.studentCount ?? 5;
  const teamEmail = options.teamEmail === undefined ? "team@example.edu.cn" : options.teamEmail;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["表1-指导教师"],
    ["团队名称", null, teamName],
    ["团队单位", null, schoolName],
    ["团队联系邮箱", null, teamEmail],
    ["序号", "指导教师姓名", "联系电话", "性别", "E-mail"],
    ...Array.from({ length: teacherCount }, (_, index) => [
      index + 1,
      `测试教师${index + 1}`,
      `1390000000${index}`,
      index % 2 === 0 ? "女" : "男",
      `teacher${index + 1}@example.edu.cn`,
    ]),
  ]), "表1-指导教师");
  const memberSheet = XLSX.utils.aoa_to_sheet([
    ["表2-团队成员"],
    ["团队名称", null, teamName],
    ["团队单位", null, schoolName],
    ["团队联系邮箱", null, teamEmail],
    ["参赛方式（线上/线下）", null, "线下"],
    ["说明"],
    ["序号", "团队成员姓名", "联系电话", "性别", "E-mail", "年级"],
    ...Array.from({ length: studentCount }, (_, index) => [
      index + 1,
      index === 0 ? "测试队长" : `测试队员${index + 1}`,
      index === 0 ? "13800138000" : `1380000000${index}`,
      index % 2 === 0 ? "女" : "男",
      options.missingStudentEmail && index === studentCount - 1 ? "" : index === 0 ? "captain@example.edu.cn" : `student${index + 1}@example.edu.cn`,
      "2024本",
    ]),
  ]);
  if (options.ghostLastRow) {
    memberSheet.D1048576 = { t: "s", v: "v" };
    memberSheet["!ref"] = "A1:F1048576";
  }
  XLSX.utils.book_append_sheet(workbook, memberSheet, "表2-团队成员");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["表3-视频竞赛报名"],
    ["团队名称", null, teamName],
    ["团队单位", null, schoolName],
    ["团队联系邮箱", null, teamEmail],
    ["是否报名视频竞赛", null, "是"],
  ]), "表3-视频竞赛报名");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

function masterWorkbookBytes() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["学校", "队名", "团队联系方式(邮箱)", "负责人", "负责人电话", "是否报名视频竞赛", "线上/线下"],
  ]), "国内");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["国家", "学校", "队名", "团队联系方式(邮箱)", "负责人", "负责人电话", "是否报名视频竞赛", "线上/线下"],
  ]), "国际");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

function loadWorker() {
  if (!workerPromise) {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    workerPromise = import(workerUrl.href).then(({ default: worker }) => worker);
  }
  return workerPromise;
}

function loadMailCollector() {
  if (!mailCollectorPromise) {
    mailCollectorPromise = Promise.all([
      readFile(new URL("../worker/alibaba-imap.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/mail-collector.ts", import.meta.url), "utf8"),
    ]).then(async ([imapSource, collectorSource]) => {
      const compilerOptions = {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
      };
      const compile = (source, fileName) => ts.transpileModule(source, { compilerOptions, fileName }).outputText;
      const imapUrl = `data:text/javascript;base64,${Buffer.from(compile(imapSource, "alibaba-imap.ts")).toString("base64")}`;
      const collectorModule = compile(collectorSource, "mail-collector.ts")
        .replaceAll('"./alibaba-imap"', JSON.stringify(imapUrl))
        .replaceAll("'./alibaba-imap'", JSON.stringify(imapUrl));
      return import(`data:text/javascript;base64,${Buffer.from(collectorModule).toString("base64")}`);
    });
  }
  return mailCollectorPromise;
}

function loadFileMetadata() {
  if (!fileMetadataPromise) {
    fileMetadataPromise = readFile(new URL("../worker/file-metadata.ts", import.meta.url), "utf8").then((source) => {
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: "file-metadata.ts",
      }).outputText;
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return fileMetadataPromise;
}

function loadEdpReviewRules() {
  if (!edpReviewRulesPromise) {
    edpReviewRulesPromise = readFile(new URL("../worker/edp-review-rules.ts", import.meta.url), "utf8").then((source) => {
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: "edp-review-rules.ts",
      }).outputText;
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpReviewRulesPromise;
}

function loadEdpReviewEngine() {
  if (!edpReviewEnginePromise) {
    edpReviewEnginePromise = Promise.all([
      readFile(new URL("../worker/edp-review-rules.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/edp-detailed-audit.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/edp-cross-document-audit.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/edp-archive-core.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/pdf-runtime.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/edp-package.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/edp-review-engine.ts", import.meta.url), "utf8"),
    ]).then(async ([rulesSource, detailedSource, crossDocumentSource, archiveCoreSource, pdfRuntimeSource, packageSource, engineSource]) => {
      const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 };
      const compile = (source, fileName) => ts.transpileModule(source, { compilerOptions, fileName }).outputText
        .replaceAll('"./native-core"', JSON.stringify(nativeCoreUrl));
      const rulesUrl = `data:text/javascript;base64,${Buffer.from(compile(rulesSource, "edp-review-rules.ts")).toString("base64")}`;
      const detailedUrl = `data:text/javascript;base64,${Buffer.from(compile(detailedSource, "edp-detailed-audit.ts")).toString("base64")}`;
      const crossDocumentUrl = `data:text/javascript;base64,${Buffer.from(compile(crossDocumentSource, "edp-cross-document-audit.ts")
        .replaceAll('"./edp-review-rules"', JSON.stringify(rulesUrl))
        .replaceAll("'./edp-review-rules'", JSON.stringify(rulesUrl))).toString("base64")}`;
      const jszipUrl = import.meta.resolve("jszip");
      const pdfjsUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
      const pdfWorkerUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
      const pdfRuntimeUrl = `data:text/javascript;base64,${Buffer.from(compile(pdfRuntimeSource, "pdf-runtime.ts")
        .replaceAll('"pdfjs-dist/legacy/build/pdf.worker.mjs"', JSON.stringify(pdfWorkerUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.worker.mjs'", JSON.stringify(pdfWorkerUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.mjs"', JSON.stringify(pdfjsUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.mjs'", JSON.stringify(pdfjsUrl))).toString("base64")}`;
      const archiveCoreUrl = `data:text/javascript;base64,${Buffer.from(compile(archiveCoreSource, "edp-archive-core.ts")
        .replaceAll('"jszip"', JSON.stringify(jszipUrl))
        .replaceAll("'jszip'", JSON.stringify(jszipUrl))).toString("base64")}`;
      const archiveStubUrl = `data:text/javascript;base64,${Buffer.from("export async function openEdpArchive(){ throw new Error('test libarchive reader was not installed'); }").toString("base64")}`;
      const packageUrl = `data:text/javascript;base64,${Buffer.from(compile(packageSource, "edp-package.ts")
        .replaceAll('"./edp-archive-core"', JSON.stringify(archiveCoreUrl))
        .replaceAll("'./edp-archive-core'", JSON.stringify(archiveCoreUrl))
        .replaceAll('"./edp-archive"', JSON.stringify(archiveStubUrl))
        .replaceAll("'./edp-archive'", JSON.stringify(archiveStubUrl))
        .replaceAll('"./pdf-runtime"', JSON.stringify(pdfRuntimeUrl))
        .replaceAll("'./pdf-runtime'", JSON.stringify(pdfRuntimeUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.worker.mjs"', JSON.stringify(pdfWorkerUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.worker.mjs'", JSON.stringify(pdfWorkerUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.mjs"', JSON.stringify(pdfjsUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.mjs'", JSON.stringify(pdfjsUrl))).toString("base64")}`;
      const output = compile(engineSource, "edp-review-engine.ts")
        .replaceAll('"./edp-review-rules"', JSON.stringify(rulesUrl))
        .replaceAll("'./edp-review-rules'", JSON.stringify(rulesUrl))
        .replaceAll('"./edp-detailed-audit"', JSON.stringify(detailedUrl))
        .replaceAll("'./edp-detailed-audit'", JSON.stringify(detailedUrl))
        .replaceAll('"./edp-cross-document-audit"', JSON.stringify(crossDocumentUrl))
        .replaceAll("'./edp-cross-document-audit'", JSON.stringify(crossDocumentUrl))
        .replaceAll('"./edp-archive-core"', JSON.stringify(archiveCoreUrl))
        .replaceAll("'./edp-archive-core'", JSON.stringify(archiveCoreUrl))
        .replaceAll('"./edp-package"', JSON.stringify(packageUrl))
        .replaceAll("'./edp-package'", JSON.stringify(packageUrl))
        .replaceAll('"./pdf-runtime"', JSON.stringify(pdfRuntimeUrl))
        .replaceAll("'./pdf-runtime'", JSON.stringify(pdfRuntimeUrl))
        .replaceAll('"jszip"', JSON.stringify(jszipUrl))
        .replaceAll("'jszip'", JSON.stringify(jszipUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.worker.mjs"', JSON.stringify(pdfWorkerUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.worker.mjs'", JSON.stringify(pdfWorkerUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.mjs"', JSON.stringify(pdfjsUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.mjs'", JSON.stringify(pdfjsUrl));
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpReviewEnginePromise;
}

function loadEdpReviewWorkbook() {
  if (!edpReviewWorkbookPromise) {
    edpReviewWorkbookPromise = readFile(new URL("../worker/edp-review-workbook.ts", import.meta.url), "utf8").then((source) => {
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: "edp-review-workbook.ts",
      }).outputText
        .replaceAll('"jszip"', JSON.stringify(import.meta.resolve("jszip")))
        .replaceAll("'jszip'", JSON.stringify(import.meta.resolve("jszip")));
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpReviewWorkbookPromise;
}

function loadEdpRuleParser() {
  if (!edpRuleParserPromise) {
    edpRuleParserPromise = Promise.all([
      readFile(new URL("../worker/edp-rule-parser.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/pdf-runtime.ts", import.meta.url), "utf8"),
    ]).then(([source, pdfRuntimeSource]) => {
      const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 };
      const pdfjsUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
      const pdfWorkerUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
      const pdfRuntimeOutput = ts.transpileModule(pdfRuntimeSource, {
        compilerOptions,
        fileName: "pdf-runtime.ts",
      }).outputText
        .replaceAll('"pdfjs-dist/legacy/build/pdf.worker.mjs"', JSON.stringify(pdfWorkerUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.worker.mjs'", JSON.stringify(pdfWorkerUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.mjs"', JSON.stringify(pdfjsUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.mjs'", JSON.stringify(pdfjsUrl));
      const pdfRuntimeUrl = `data:text/javascript;base64,${Buffer.from(pdfRuntimeOutput).toString("base64")}`;
      const output = ts.transpileModule(source, {
        compilerOptions,
        fileName: "edp-rule-parser.ts",
      }).outputText
        .replaceAll('"./pdf-runtime"', JSON.stringify(pdfRuntimeUrl))
        .replaceAll("'./pdf-runtime'", JSON.stringify(pdfRuntimeUrl));
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpRuleParserPromise;
}

test("EDP filenames cannot make a first-round MOC form count as English EDP", async () => {
  const { inspectEdpPackage } = await loadEdpPackage();
  const names = ["测试大学-中文版EDP.pdf", "测试大学-英文版EDP.pdf", "测试大学-EDP增补文件.pdf"];
  const entries = names.map(path => ({ originalPath:path,normalizedPath:path,displayPath:path,
    displayNameStatus:"reliable",isDirectory:false,declaredSize:10,
    bytes:new TextEncoder().encode("%PDF-1.7\n") }));
  const result = await inspectEdpPackage(new Uint8Array(), "test.zip", 1, {
    validatePdfContents:true,
    openArchive:async () => ({format:"zip",entries}),
    extractFirstPageText:async (_, path) => path.includes("英文")
      ? "Version 1.0 MANAGEMENT OF CHANGE REQUEST FORM Name of Person or Group Requesting Change Date Summary Description of Change"
      : path.includes("增补") ? "EDP Supplement" : "工程文件包 工作安全评估表 动力来源 控制机制",
  });
  assert.equal(result.qualified, false);
  assert.ok(result.documents.some(document => document.role === "moc" && document.displayPath.includes("英文")));
  assert.match(result.reasons.join(" "), /英文版 EDP|MOC/u);
});

test("an EDP cover mentioning MOC instructions is not misclassified as a MOC form", async () => {
  const { inspectEdpPackage } = await loadEdpPackage();
  const names = ["测试大学-中文版EDP.pdf", "测试大学-英文版EDP.pdf", "测试大学-EDP增补文件.pdf"];
  const entries = names.map(path => ({ originalPath:path,normalizedPath:path,displayPath:path,
    displayNameStatus:"reliable",isDirectory:false,declaredSize:10,
    bytes:new TextEncoder().encode("%PDF-1.7\n") }));
  const result = await inspectEdpPackage(new Uint8Array(), "test.zip", 1, {
    validatePdfContents:true,
    openArchive:async () => ({format:"zip",entries}),
    extractFirstPageText:async (_, path) => path.includes("英文")
      ? "Engineering Documentation Package (EDP) School Name Test University. Submit Management of Change after revision."
      : path.includes("增补") ? "EDP Supplement" : "工程文件包 工作安全评估表 动力来源 控制机制",
  });
  assert.equal(result.qualified, true);
});

function loadEdpDetailedAudit() {
  if (!edpDetailedAuditPromise) {
    edpDetailedAuditPromise = readFile(new URL("../worker/edp-detailed-audit.ts", import.meta.url), "utf8").then((source) => {
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: "edp-detailed-audit.ts",
      }).outputText;
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpDetailedAuditPromise;
}

function loadEdpCrossDocumentAudit() {
  if (!edpCrossDocumentAuditPromise) {
    edpCrossDocumentAuditPromise = Promise.all([
      readFile(new URL("../worker/edp-review-rules.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/edp-cross-document-audit.ts", import.meta.url), "utf8"),
    ]).then(([rulesSource, crossDocumentSource]) => {
      const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 };
      const compile = (source, fileName) => ts.transpileModule(source, { compilerOptions, fileName }).outputText;
      const rulesUrl = `data:text/javascript;base64,${Buffer.from(compile(rulesSource, "edp-review-rules.ts")).toString("base64")}`;
      const output = compile(crossDocumentSource, "edp-cross-document-audit.ts")
        .replaceAll('"./edp-review-rules"', JSON.stringify(rulesUrl))
        .replaceAll("'./edp-review-rules'", JSON.stringify(rulesUrl));
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpCrossDocumentAuditPromise;
}

function loadEdpArchiveCore() {
  if (!edpArchiveCorePromise) {
    edpArchiveCorePromise = readFile(new URL("../worker/edp-archive-core.ts", import.meta.url), "utf8").then((source) => {
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: "edp-archive-core.ts",
      }).outputText
        .replaceAll('"jszip"', JSON.stringify(import.meta.resolve("jszip")))
        .replaceAll("'jszip'", JSON.stringify(import.meta.resolve("jszip")));
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpArchiveCorePromise;
}

function loadEdpPackage() {
  if (!edpPackagePromise) {
    edpPackagePromise = Promise.all([
      readFile(new URL("../worker/edp-package.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/pdf-runtime.ts", import.meta.url), "utf8"),
    ]).then(([source, pdfRuntimeSource]) => {
      const archiveStub = "export function sniffEdpArchiveFormat(){ return 'zip'; } export async function openEdpArchiveCore(){ throw new Error('openArchive dependency required'); } export async function openEdpArchive(){ throw new Error('openArchive dependency required'); }";
      const archiveStubUrl = `data:text/javascript;base64,${Buffer.from(archiveStub).toString("base64")}`;
      const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 };
      const pdfjsUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
      const pdfWorkerUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
      const pdfRuntimeOutput = ts.transpileModule(pdfRuntimeSource, {
        compilerOptions,
        fileName: "pdf-runtime.ts",
      }).outputText
        .replaceAll('"pdfjs-dist/legacy/build/pdf.worker.mjs"', JSON.stringify(pdfWorkerUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.worker.mjs'", JSON.stringify(pdfWorkerUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.mjs"', JSON.stringify(pdfjsUrl))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.mjs'", JSON.stringify(pdfjsUrl));
      const pdfRuntimeUrl = `data:text/javascript;base64,${Buffer.from(pdfRuntimeOutput).toString("base64")}`;
      const output = ts.transpileModule(source, {
        compilerOptions,
        fileName: "edp-package.ts",
      }).outputText
        .replaceAll('"./native-core"', JSON.stringify(nativeCoreUrl))
        .replaceAll('"./edp-archive-core"', JSON.stringify(archiveStubUrl))
        .replaceAll("'./edp-archive-core'", JSON.stringify(archiveStubUrl))
        .replaceAll('"./edp-archive"', JSON.stringify(archiveStubUrl))
        .replaceAll("'./edp-archive'", JSON.stringify(archiveStubUrl))
        .replaceAll('"./pdf-runtime"', JSON.stringify(pdfRuntimeUrl))
        .replaceAll("'./pdf-runtime'", JSON.stringify(pdfRuntimeUrl))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.worker.mjs"', JSON.stringify(import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.worker.mjs'", JSON.stringify(import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")))
        .replaceAll('"pdfjs-dist/legacy/build/pdf.mjs"', JSON.stringify(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")))
        .replaceAll("'pdfjs-dist/legacy/build/pdf.mjs'", JSON.stringify(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")));
      return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    });
  }
  return edpPackagePromise;
}

async function readLibarchiveEntriesForTest(bytes) {
  const { ArchiveReader, libarchiveWasm } = await import("libarchive-wasm");
  const wasmModule = await libarchiveWasm();
  const source = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reader = new ArchiveReader(wasmModule, source);
  try {
    if (reader.hasEncryptedData()) throw new Error("encrypted archive");
    const entries = Array.from(reader.entries(), (entry) => {
      const pathname = entry.getPathname();
      const size = Number(entry.getSize());
      const isDirectory = entry.getFiletype() === "Directory";
      if (entry.isEncrypted()) throw new Error("encrypted archive");
      const data = isDirectory ? null : entry.readData();
      return {
        pathname,
        size: Number.isSafeInteger(size) && size >= 0 ? size : null,
        isDirectory,
        bytes: data ? new Uint8Array(data) : null,
      };
    });
    if (reader.hasEncryptedData()) throw new Error("encrypted archive");
    return entries;
  } finally {
    reader.free();
  }
}

async function render() {
  const worker = await loadWorker();
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

function compareVersions(left, right) {
  const timeDifference = Date.parse(left.submitted_at) - Date.parse(right.submitted_at);
  if (timeDifference !== 0) return timeDifference;
  if (/^\d+$/.test(left.submission_id) && /^\d+$/.test(right.submission_id)) {
    const leftId = BigInt(left.submission_id);
    const rightId = BigInt(right.submission_id);
    return leftId === rightId ? 0 : leftId > rightId ? 1 : -1;
  }
  return left.submission_id === right.submission_id ? 0 : left.submission_id > right.submission_id ? 1 : -1;
}

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  first() {
    return this.database.first(this.sql, this.values);
  }

  all() {
    return this.database.all(this.sql, this.values);
  }

  run() {
    return this.database.run(this.sql, this.values);
  }
}

class FakeD1 {
  constructor({ submission = null, issue = null, mailSettings = null, appSecuritySettings = null, edpReceiptSettings = null, registrationReceiptEmail = "" } = {}) {
    this.submission = submission ? structuredClone(submission) : null;
    this.issue = issue ? structuredClone(issue) : null;
    this.mailSettings = mailSettings ? structuredClone(mailSettings) : null;
    this.appSecuritySettings = appSecuritySettings ? structuredClone(appSecuritySettings) : null;
    this.edpReceiptSettings = edpReceiptSettings ? structuredClone(edpReceiptSettings) : null;
    this.registrationReceiptEmail = registrationReceiptEmail;
    this.mediaRows = new Map();
    this.mediaSettings = new Map();
    this.mediaUploadSessions = new Map();
    this.authAttempts = new Map();
    this.queryLog = [];
  }

  mediaRowKey(userId, kind, schoolKey) {
    return `${userId}:${kind}:${schoolKey}`;
  }

  mediaSettingKey(userId, kind) {
    return `${userId}:${kind}`;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async first(sql, values = []) {
    this.queryLog.push({ kind: "first", sql, values: [...values] });
    if (/\bINSERT\s+INTO\s+auth_login_attempts\b/i.test(sql)) {
      const [clientHash, now, cutoff, maximumFailures, lockUntil] = values;
      const current = this.authAttempts.get(clientHash);
      let next;
      if (!current) {
        next = {
          client_hash: clientHash,
          window_started_at: now,
          failure_count: 1,
          locked_until: null,
          updated_at: now,
        };
      } else if (current.locked_until && current.locked_until > now) {
        next = { ...current, updated_at: now };
      } else if (current.window_started_at <= cutoff) {
        next = {
          client_hash: clientHash,
          window_started_at: now,
          failure_count: 1,
          locked_until: null,
          updated_at: now,
        };
      } else {
        next = {
          ...current,
          failure_count: current.failure_count >= maximumFailures ? current.failure_count : current.failure_count + 1,
          locked_until: current.failure_count >= maximumFailures ? lockUntil : null,
          updated_at: now,
        };
      }
      this.authAttempts.set(clientHash, next);
      return structuredClone(next);
    }
    if (/\bINSERT\s+INTO\s+mail_settings\b/i.test(sql)) {
      await this.run(sql, values);
      return { user_id: values[0] };
    }
    if (/\bINSERT\s+INTO\s+app_security_settings\b/i.test(sql)) {
      const [sharedPasswordHash, passwordVersion, updatedAt, expectedPasswordVersion] = values;
      if (this.appSecuritySettings && this.appSecuritySettings.password_version !== expectedPasswordVersion) return null;
      this.appSecuritySettings = {
        singleton_id: 1,
        shared_password_hash: sharedPasswordHash,
        password_version: passwordVersion,
        updated_at: updatedAt,
      };
      return { password_version: passwordVersion };
    }
    if (/\bFROM\s+edp_submissions\b/i.test(sql)) return this.submission ? structuredClone(this.submission) : null;
    if (/\bFROM\s+edp_issues\b/i.test(sql)) return this.issue ? structuredClone(this.issue) : null;
    if (/\bFROM\s+edp_receipt_settings\b/i.test(sql)) return this.edpReceiptSettings ? structuredClone(this.edpReceiptSettings) : null;
    if (/\bFROM\s+registration_receipts\b/i.test(sql) && /recipient_email/i.test(sql)) {
      return this.registrationReceiptEmail ? { recipient_email: this.registrationReceiptEmail } : null;
    }
    if (/\bFROM\s+shared_media_assets\b/i.test(sql)) {
      return structuredClone(this.mediaRows.get(this.mediaRowKey(values[0], values[1], values[2])) ?? null);
    }
    if (/\bFROM\s+media_collector_settings\b/i.test(sql)) {
      return structuredClone(this.mediaSettings.get(this.mediaSettingKey(values[0], values[1])) ?? null);
    }
    if (/\bFROM\s+media_upload_sessions\b/i.test(sql)) {
      const row = this.mediaUploadSessions.get(`${values[0]}:${values[1]}`);
      return row?.kind === values[2] ? structuredClone(row) : null;
    }
    if (/\bFROM\s+mail_settings\b/i.test(sql)) return this.mailSettings ? structuredClone(this.mailSettings) : null;
    if (/\bFROM\s+app_security_settings\b/i.test(sql)) {
      return this.appSecuritySettings ? structuredClone(this.appSecuritySettings) : null;
    }
    return null;
  }

  async all(sql, values = []) {
    this.queryLog.push({ kind: "all", sql, values: [...values] });
    if (/\bFROM\s+shared_media_assets\b/i.test(sql)) {
      return {
        results: [...this.mediaRows.values()]
          .filter((row) => row.user_id === values[0] && row.kind === values[1])
          .map((row) => structuredClone(row)),
      };
    }
    return { results: [] };
  }

  async run(sql, values) {
    this.queryLog.push({ kind: "run", sql, values: [...values] });
    if (/\bINSERT\s+INTO\s+edp_submissions\b/i.test(sql)) {
      const incoming = {
        school_key: values[1],
        school_name: values[2],
        r2_key: values[3],
        filename: values[4],
        content_type: values[5],
        submitted_at: values[6],
        submission_id: values[7],
        size: values[8],
        file_count: values[9],
        uploaded_at: values[10],
        submission_round: values[11],
        submission_round_source: values[12],
        archive_format: values[13],
        embedded_registration_filename: values[14],
        embedded_registration_status: values[15],
        embedded_registration_message: values[16],
      };
      if (!this.submission || compareVersions(incoming, this.submission) > 0) this.submission = incoming;
    } else if (/\bUPDATE\s+edp_submissions\s+SET\s+embedded_registration_filename\b/i.test(sql)) {
      if (this.submission
        && this.submission.school_key === values[4]
        && this.submission.submitted_at === values[5]
        && this.submission.submission_id === values[6]) {
        this.submission = {
          ...this.submission,
          embedded_registration_filename: values[0],
          embedded_registration_status: values[1],
          embedded_registration_message: values[2],
        };
      }
    } else if (/\bINSERT\s+INTO\s+edp_issues\b/i.test(sql)) {
      const incoming = {
        school_key: values[1],
        school_name: values[2],
        filename: values[3],
        submitted_at: values[4],
        submission_id: values[5],
        file_count: values[6],
        reason_code: values[7],
        reason_codes_json: values[8],
        reasons_json: values[9],
        created_at: values[10],
      };
      if (!this.issue || compareVersions(incoming, this.issue) > 0) this.issue = incoming;
    } else if (/\bINSERT\s+INTO\s+edp_receipt_settings\b/i.test(sql)) {
      this.edpReceiptSettings = {
        competition_year: values[1],
        submission_round: values[2],
        updated_at: values[3],
      };
    } else if (/\bINSERT\s+INTO\s+shared_media_assets\b/i.test(sql)) {
      const incoming = {
        user_id: values[0],
        kind: values[1],
        school_key: values[2],
        school_name: values[3],
        r2_key: values[4],
        filename: values[5],
        content_type: values[6],
        size: values[7],
        submitted_at: values[8],
        submission_id: values[9],
        uploaded_at: values[10],
      };
      const key = this.mediaRowKey(incoming.user_id, incoming.kind, incoming.school_key);
      const current = this.mediaRows.get(key);
      if (!current || compareVersions(incoming, current) > 0) this.mediaRows.set(key, incoming);
    } else if (/\bINSERT\s+INTO\s+media_collector_settings\b/i.test(sql)) {
      this.mediaSettings.set(this.mediaSettingKey(values[0], values[1]), {
        user_id: values[0],
        kind: values[1],
        starts_at: values[2],
        run_time: values[3],
        timezone: values[4],
        interval_minutes: values[5],
        enabled: values[6],
        next_run_at: values[7],
        updated_at: values[8],
      });
    } else if (/\bINSERT\s+INTO\s+media_upload_sessions\b/i.test(sql)) {
      this.mediaUploadSessions.set(`${values[0]}:${values[1]}`, {
        user_id: values[0],
        session_id: values[1],
        kind: values[2],
        school_key: values[3],
        school_name: values[4],
        filename: values[5],
        total_size: values[6],
        submitted_at: values[7],
        submission_id: values[8],
        temp_r2_key: values[9],
        r2_upload_id: values[10],
        part_size: values[11],
        content_type: null,
        created_at: values[12],
        expires_at: values[13],
      });
    } else if (/\bUPDATE\s+media_upload_sessions\s+SET\s+content_type\b/i.test(sql)) {
      const key = `${values[1]}:${values[2]}`;
      const current = this.mediaUploadSessions.get(key);
      if (current?.kind === values[3]) this.mediaUploadSessions.set(key, { ...current, content_type: values[0] });
    } else if (/\bDELETE\s+FROM\s+media_upload_sessions\b/i.test(sql)) {
      this.mediaUploadSessions.delete(`${values[0]}:${values[1]}`);
    } else if (/\bINSERT\s+INTO\s+mail_settings\b/i.test(sql)) {
      this.mailSettings = {
        user_id: values[0],
        email: values[1],
        imap_host: values[2],
        imap_port: values[3],
        credential_ciphertext: values[4],
        starts_at: values[5],
        run_time: values[6],
        timezone: values[7],
        interval_minutes: values[8],
        enabled: values[9],
        next_run_at: values[10],
        uid_validity: values[11],
        last_uid: values[12],
        last_synced_at: values[13],
        last_sync_status: values[14],
        last_sync_error: values[15],
        sync_lock_token: null,
        sync_lock_until: null,
        updated_at: values[16],
      };
    } else if (/\bDELETE\s+FROM\s+edp_issues\b/i.test(sql) && this.issue && this.submission) {
      if (compareVersions(this.submission, this.issue) >= 0) this.issue = null;
    } else if (/\bDELETE\s+FROM\s+auth_login_attempts\b/i.test(sql)) {
      this.authAttempts.delete(values[0]);
    } else if (/\bUPDATE\s+auth_login_attempts\b/i.test(sql)) {
      const [now, lockUntil, updatedAt, clientHash] = values;
      const current = this.authAttempts.get(clientHash);
      if (current) {
        this.authAttempts.set(clientHash, {
          ...current,
          locked_until: !current.locked_until || current.locked_until <= now ? lockUntil : current.locked_until,
          updated_at: updatedAt,
        });
      }
    }
    return { success: true, meta: {} };
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.putCalls = [];
    this.multipartUploads = new Map();
    this.multipartCounter = 0;
  }

  seed(key, row) {
    this.objects.set(key, {
      customMetadata: {
        submittedAt: row.submitted_at,
        submissionId: row.submission_id,
        schoolName: row.school_name,
        filename: row.filename,
        fileCount: String(row.file_count),
      },
      size: row.size,
      uploaded: new Date(row.uploaded_at),
      httpEtag: '"seed"',
      httpMetadata: { contentType: "application/zip" },
      bytes: new Uint8Array(row.size),
    });
  }

  seedBytes(key, bytes, { contentType = "application/octet-stream", customMetadata = {} } = {}) {
    const copied = new Uint8Array(bytes);
    this.objects.set(key, {
      customMetadata: { ...customMetadata },
      size: copied.byteLength,
      uploaded: new Date(),
      httpEtag: `"seed-${this.objects.size + 1}"`,
      httpMetadata: { contentType },
      bytes: copied,
    });
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...object,
      body: new Response(object.bytes).body,
      async arrayBuffer() {
        return object.bytes.slice().buffer;
      },
      writeHttpMetadata(headers) {
        if (object.httpMetadata?.contentType) headers.set("Content-Type", object.httpMetadata.contentType);
      },
    };
  }

  createMultipartUpload(key, options = {}) {
    const uploadId = `multipart-${++this.multipartCounter}`;
    this.multipartUploads.set(uploadId, { key, options, parts: new Map() });
    return this.multipartHandle(key, uploadId);
  }

  resumeMultipartUpload(key, uploadId) {
    return this.multipartHandle(key, uploadId);
  }

  multipartHandle(key, uploadId) {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, body) => {
        const upload = this.multipartUploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("multipart upload not found");
        const bytes = await readBodyBytes(body);
        const etag = `part-${partNumber}-${bytes.byteLength}`;
        upload.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      complete: async (parts) => {
        const upload = this.multipartUploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("multipart upload not found");
        const chunks = parts.map(({ partNumber, etag }) => {
          const part = upload.parts.get(partNumber);
          if (!part || part.etag !== etag) throw new Error("multipart part mismatch");
          return part.bytes;
        });
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const object = {
          customMetadata: { ...(upload.options.customMetadata ?? {}) },
          httpMetadata: { ...(upload.options.httpMetadata ?? {}) },
          size: bytes.byteLength,
          uploaded: new Date(),
          httpEtag: `"multipart-${uploadId}"`,
          bytes,
        };
        this.objects.set(key, object);
        this.multipartUploads.delete(uploadId);
        return object;
      },
      abort: async () => {
        this.multipartUploads.delete(uploadId);
      },
    };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async put(key, body, options = {}) {
    const current = this.objects.get(key);
    const onlyIf = options.onlyIf instanceof Headers ? options.onlyIf : null;
    const etagDoesNotMatch = onlyIf?.get("If-None-Match") ?? options.onlyIf?.etagDoesNotMatch;
    const headerEtagMatches = onlyIf?.get("If-Match");
    const structuredEtagMatches = onlyIf ? null : options.onlyIf?.etagMatches;
    if (etagDoesNotMatch === "*" && current) return null;
    if (headerEtagMatches && headerEtagMatches !== current?.httpEtag) return null;
    if (structuredEtagMatches && structuredEtagMatches !== current?.httpEtag?.replace(/^"|"$/gu, "")) return null;
    if (
      options.customMetadata?.encoding === "b64url-utf8-v1" &&
      body instanceof ReadableStream &&
      !testFixedLengthStreams.has(body)
    ) {
      throw new TypeError("Provided readable stream must have a known length");
    }

    const bytes = await readBodyBytes(body);
    this.putCalls.push({ key, options, bytes });
    const object = {
      customMetadata: { ...(options.customMetadata ?? {}) },
      httpMetadata: { ...(options.httpMetadata ?? {}) },
      size: bytes.byteLength,
      uploaded: new Date(),
      httpEtag: `"etag-${this.putCalls.length}"`,
      bytes,
    };
    this.objects.set(key, object);
    return object;
  }
}

async function readBodyBytes(body) {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body === null || body === undefined) return new Uint8Array();
  throw new TypeError("unsupported fake R2 body");
}

function scriptedImapSocket({ uidValidity = "777", uids, messages }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const commands = [];
  let controller;
  let cancelled = false;
  let commandBuffer = "";

  const enqueue = (value) => {
    if (!cancelled) controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
  };
  const respond = (line) => {
    commands.push(line);
    const tagged = line.match(/^(C\d+)\s+(.+)$/u);
    assert.ok(tagged, `unexpected IMAP command: ${line}`);
    const [, tag, command] = tagged;
    if (command.startsWith("LOGIN ")) {
      enqueue(`${tag} OK LOGIN completed\r\n`);
      return;
    }
    if (command === "EXAMINE \"INBOX\"") {
      const uidNext = uids.length > 0 ? Math.max(...uids) + 1 : 1;
      enqueue(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${uidNext}] next UID\r\n${tag} OK EXAMINE completed\r\n`);
      return;
    }
    const search = command.match(/^UID SEARCH UID (\d+):\*$/u);
    if (search) {
      const since = Number(search[1]) - 1;
      const visible = uids.filter((uid) => uid > since);
      enqueue(`* SEARCH${visible.length > 0 ? ` ${visible.join(" ")}` : ""}\r\n${tag} OK SEARCH completed\r\n`);
      return;
    }
    const fetch = command.match(/^UID FETCH (\d+) /u);
    if (fetch) {
      const uid = Number(fetch[1]);
      const rawBytes = messages.get(uid);
      assert.ok(rawBytes, `no scripted message for UID ${uid}`);
      enqueue(`* 1 FETCH (UID ${uid} RFC822.SIZE ${rawBytes.byteLength} INTERNALDATE "01-Jun-2027 10:00:00 +0800" BODY.PEEK[] {${rawBytes.byteLength}}\r\n`);
      enqueue(rawBytes);
      enqueue(`\r\n)\r\n${tag} OK FETCH completed\r\n`);
      return;
    }
    if (command === "LOGOUT") {
      enqueue(`* BYE closing\r\n${tag} OK LOGOUT completed\r\n`);
      return;
    }
    enqueue(`${tag} BAD unsupported test command\r\n`);
  };

  const readable = new ReadableStream({
    start(streamController) {
      controller = streamController;
      enqueue("* OK test IMAP ready\r\n");
    },
    cancel() {
      cancelled = true;
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      commandBuffer += decoder.decode(chunk, { stream: true });
      while (commandBuffer.includes("\r\n")) {
        const boundary = commandBuffer.indexOf("\r\n");
        const line = commandBuffer.slice(0, boundary);
        commandBuffer = commandBuffer.slice(boundary + 2);
        respond(line);
      }
    },
  });
  return {
    commands,
    socketFactory: () => ({
      readable,
      writable,
      async close() {
        cancelled = true;
      },
    }),
  };
}

const PDF_BYTES = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n";

function simpleTextPdfBytes(text) {
  const escapePdfText = (value) => value.replace(/([\\()])/gu, "\\$1");
  const lines = text.split(/\s*\|\s*/u);
  const textOperations = lines.map((line, index) => `${index ? "T* " : ""}(${escapePdfText(line)}) Tj`).join("\n");
  const stream = `BT /F1 10 Tf 50 760 Td 14 TL\n${textOperations}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

const AUTH_ORIGIN = "https://collector.example.test";
const TEST_PASSWORD = "Chem-E-Car 2027 安全密码";
const TEST_FOUNDER_PASSWORD = "Founder-only 2027 安全密码";
const TEST_NEW_SHARED_PASSWORD = "New shared 2027! 安全密码";
const TEST_SESSION_SECRET = "test-session-secret-for-chem-e-car-console-v1";
const TEST_CREDENTIAL_KEY = encodeBase64Url(new TextEncoder().encode("0123456789abcdef0123456789abcdef"));
let passwordHashPromise;
let founderPasswordHashPromise;

function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function passwordHashFor(password, saltLabel, iterations = 100_000) {
  const salt = new TextEncoder().encode(saltLabel);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256,
  ));
  return `pbkdf2-sha256$${iterations}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
}

function configuredPasswordHash() {
  if (!passwordHashPromise) {
    passwordHashPromise = passwordHashFor(TEST_PASSWORD, "chemecar-test-salt-v1");
  }
  return passwordHashPromise;
}

function configuredFounderPasswordHash() {
  if (!founderPasswordHashPromise) {
    founderPasswordHashPromise = passwordHashFor(TEST_FOUNDER_PASSWORD, "chemecar-founder-test-salt-v1");
  }
  return founderPasswordHashPromise;
}

async function signedSessionToken(secret, { issuedAt, expiresAt, passwordVersion = 1 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    pv: passwordVersion,
    iat: issuedAt ?? now,
    exp: expiresAt ?? now + 60 * 60,
    nonce: "abcdefghijklmnopqrstuvwx",
  };
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`chemecar-session-v1.${encodedPayload}`),
  ));
  return `${encodedPayload}.${encodeBase64Url(signature)}`;
}

async function makeAuthEnv(options = {}) {
  const env = {
    DB: options.DB ?? new FakeD1(),
    FILES: options.FILES ?? new FakeR2(),
    APP_ACCESS_PASSWORD_HASH: await configuredPasswordHash(),
    APP_SESSION_SECRET: TEST_SESSION_SECRET,
    APP_CREDENTIAL_ENCRYPTION_KEY: options.APP_CREDENTIAL_ENCRYPTION_KEY ?? TEST_CREDENTIAL_KEY,
  };
  if (options.APP_FOUNDER_PASSWORD_HASH !== undefined) {
    env.APP_FOUNDER_PASSWORD_HASH = options.APP_FOUNDER_PASSWORD_HASH;
  }
  return env;
}

async function authenticatedCookie() {
  return `__Host-chemecar_session=${await signedSessionToken(TEST_SESSION_SECRET)}`;
}

async function decryptStoredCredential(ciphertext, keyB64url) {
  const [version, encodedIv, encodedPayload] = ciphertext.split(".");
  assert.equal(version, "v1");
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(keyB64url, "base64url"),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(encodedIv, "base64url"),
      additionalData: new TextEncoder().encode("chem-e-car:mail-credential:v1"),
      tagLength: 128,
    },
    key,
    Buffer.from(encodedPayload, "base64url"),
  );
  return new TextDecoder().decode(decrypted);
}

async function callApi(worker, env, path, { method = "GET", origin, cookie, headers, body } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", origin);
  if (cookie) requestHeaders.set("Cookie", cookie);
  const response = await worker.fetch(
    new Request(new URL(path, AUTH_ORIGIN), { method, headers: requestHeaders, body }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  return response;
}

function loginRequest(worker, env, password, options = {}) {
  return callApi(worker, env, "/api/auth/login", {
    method: "POST",
    origin: options.withoutOrigin ? undefined : AUTH_ORIGIN,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": options.ip ?? "203.0.113.8",
    },
    body: JSON.stringify({ password }),
  });
}

function founderPasswordRequest(worker, env, founderPassword, newPassword, options = {}) {
  return callApi(worker, env, "/api/founder/password", {
    method: "POST",
    origin: options.withoutOrigin ? undefined : AUTH_ORIGIN,
    cookie: options.cookie,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": options.ip ?? "203.0.113.18",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify({ founderPassword, newPassword }),
  });
}

async function makeEdpZip({ moc = false, badEnglishHeader = false, duplicateChinese = false, wordChinese = false } = {}) {
  const zip = new JSZip();
  const root = "华东理工大学EDP（第二版）/";
  const cover = [
    "University: East China University of Science and Technology",
    "Vehicle Name: Roadrunner",
    "Team Captain Name: Alice Chen",
    "Team Captain Email: captain@example.edu.cn",
    "Faculty Supervisor: Professor Li",
    "Supervisor Email: professor.li@example.edu.cn",
    "Revision #: 2",
    "Revision Date: 2026-05-23",
  ].join(" | ");
  zip.file(
    `${root}华东理工大学EDP（第二版）.${wordChinese ? "docx" : "pdf"}`,
    wordChinese ? new Uint8Array([0x50, 0x4b, 0x03, 0x04]) : simpleTextPdfBytes(cover),
  );
  zip.file(`${root}East China University of Science and Technology EDP.pdf`, badEnglishHeader ? "not a pdf" : simpleTextPdfBytes(cover));
  zip.file(
    `${root}${duplicateChinese ? "华东理工大学EDP中文版补交.pdf" : "华东理工大学增补文件.pdf"}`,
    simpleTextPdfBytes("Supplement MSDS safety training certificate and manufacturer equipment specifications."),
  );
  if (moc) zip.file(`${root}MOC.pdf`, simpleTextPdfBytes("Management of Change Description of Change Reasons for Change Safety Evaluation Checklist Approval."));

  // Real-world macOS and Windows artifacts must not count as business files.
  zip.file("__MACOSX/._华东理工大学EDP（第二版）", new Uint8Array([0, 5, 22, 7]));
  zip.file(`__MACOSX/${root}._华东理工大学增补文件.pdf`, new Uint8Array([0, 5, 22, 7]));
  zip.file(".DS_Store", "metadata");
  zip.file("Thumbs.db", "metadata");

  const bytes = await zip.generateAsync({ type: "uint8array" });
  const file = new File([bytes], "华东理工大学EDP.zip", { type: "application/zip" });
  file.testSubmissionRound = moc ? 2 : 1;
  return file;
}

function acceptedSubmission(overrides = {}) {
  return {
    school_key: "华东理工大学",
    school_name: "华东理工大学",
    r2_key: "users/test/edp/%E5%8D%8E%E4%B8%9C%E7%90%86%E5%B7%A5%E5%A4%A7%E5%AD%A6/current.zip",
    filename: "华东理工大学EDP.zip",
    submitted_at: "2026-05-01T01:00:00.000Z",
    submission_id: "100",
    size: 1024,
    file_count: 3,
    uploaded_at: "2026-05-01T01:01:00.000Z",
    ...overrides,
  };
}

async function postEdp(worker, env, file, { submittedAt, submissionId }) {
  if (env.DB instanceof FakeD1 && (!env.DB.edpReceiptSettings || env.DB.edpReceiptSettings.test_auto)) {
    env.DB.edpReceiptSettings = {
      competition_year: "2025",
      submission_round: file.testSubmissionRound ?? 1,
      updated_at: "2026-01-01T00:00:00.000Z",
      test_auto: true,
    };
  }
  env.APP_SESSION_SECRET = TEST_SESSION_SECRET;
  const sessionToken = await signedSessionToken(TEST_SESSION_SECRET);
  const form = new FormData();
  form.append("file", file);
  form.append("schoolName", "华东理工大学");
  form.append("submittedAt", submittedAt);
  form.append("submissionId", submissionId);
  const response = await worker.fetch(
    new Request("http://localhost/api/edp-submissions", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        Cookie: `chemecar_session=${sessionToken}`,
      },
      body: form,
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { response, payload: await response.json() };
}

async function postMedia(worker, env, {
  kind = "poster",
  schoolName = "天津大学",
  submittedAt,
  submissionId,
  filename,
  bytes,
}) {
  const cookie = await authenticatedCookie();
  const query = new URLSearchParams({ schoolName, submittedAt, submissionId });
  const response = await callApi(worker, env, `/api/media/${kind}?${query}`, {
    method: "POST",
    origin: AUTH_ORIGIN,
    cookie,
    headers: {
      "Content-Type": kind === "video" ? "video/mp4" : "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "X-File-Name": encodeURIComponent(filename),
    },
    body: bytes,
  });
  return { response, payload: await response.json() };
}

test("Worker PDF runtime loads and reads a PDF without Node canvas globals", async () => {
  const runtime = await loadPdfRuntime();
  const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  const domMatrixDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DOMMatrix");
  try {
    Object.defineProperty(globalThis, "process", { configurable: true, value: undefined, writable: true });
    Reflect.deleteProperty(globalThis, "DOMMatrix");
    const pdfjs = await runtime.loadPdfJs();
    assert.equal(typeof globalThis.DOMMatrix, "function", "the Worker runtime must install DOMMatrix before PDF.js evaluates");
    const loadingTask = pdfjs.getDocument({
      data: simpleTextPdfBytes("Worker PDF parsing succeeds"),
      disableWorker: true,
      useSystemFonts: true,
    });
    try {
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      assert.match(content.items.map((item) => item.str || "").join(" "), /Worker PDF parsing succeeds/u);
    } finally {
      await loadingTask.destroy();
    }
  } finally {
    if (processDescriptor) Object.defineProperty(globalThis, "process", processDescriptor);
    else Reflect.deleteProperty(globalThis, "process");
    if (domMatrixDescriptor) Object.defineProperty(globalThis, "DOMMatrix", domMatrixDescriptor);
    else Reflect.deleteProperty(globalThis, "DOMMatrix");
  }
});

test("server-renders the blue-and-white password gate and wires login, status, and logout", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Chem-E-Car 赛事资料共享中心<\/title>/i);
  assert.match(html, /class="auth-shell"/);
  assert.match(html, /赛事资料中心/);
  assert.match(html, /报名表与 EDP、阿里邮箱邮件、海报和视频/);
  assert.match(html, /正在检查登录状态/);
  assert.match(html, /独立密码保护赛事资料/);

  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /独立密码登录/);
  assert.match(dashboard, /requestJson<AuthStatusResponse>\("\/api\/auth\/status"/);
  assert.match(dashboard, /requestJson<AuthStatusResponse>\("\/api\/auth\/login"/);
  assert.match(dashboard, /requestJson<\{ ok: true \}>\("\/api\/auth\/logout"/);
  assert.match(css, /\.auth-shell[^}]*linear-gradient[^}]*#edf5ff/s);
  assert.match(css, /\.auth-stage[^}]*background:#fff/s);
});

test("keeps founder and mail-media controls password-only, accessible, and free of browser storage", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /requestJson<FounderPasswordResponse>\("\/api\/founder\/password"/);
  assert.match(dashboard, /role="dialog" aria-modal="true" aria-labelledby="founder-dialog-title" aria-describedby="founder-dialog-description"/);
  assert.match(dashboard, /type="password" required minLength=\{12\} maxLength=\{128\} autoComplete="new-password"/);
  assert.match(dashboard, /本页面不会保存或回显任何密码/);
  assert.doesNotMatch(dashboard, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(dashboard, /href="https:\/\/qiye\.aliyun\.com\/alimail\/entries\/v5\.1\/mail\/inbox\/all" target="_blank" rel="noopener noreferrer"/);
  assert.match(dashboard, /href="https:\/\/help\.aliyun\.com\/zh\/document_detail\/444269\.html" target="_blank" rel="noopener noreferrer"/);
  assert.match(dashboard, /本站当前安全解析单附件上限为 20MB/);
  assert.match(dashboard, /单文件上限 200MB/);
  assert.match(dashboard, /1GB 文件只能作为“超大附件”临时下载链接出现/);
  assert.match(dashboard, /\/api\/mail-media-candidates\/\$\{encodeURIComponent\(id\)\}\/assign/);
  assert.match(dashboard, /来源：\{sourceLabel\}/);
  assert.match(css, /\.founder-dialog[^}]*max-height:calc\(100vh - 44px\)[^}]*overflow:auto/s);
  assert.match(css, /@media \(max-width:600px\)[\s\S]*\.founder-dialog[^}]*width:100%/);
});

test("opens the configured Fanke form result view from a logged-in management page", async () => {
  const messages = extensionMessageEvent();
  let clicks = 0;
  const row = { textContent: "表单 13 参赛文件收集", querySelectorAll: () => [] };
  const viewResults = {
    textContent: "查看结果",
    className: "view-results",
    dataset: {},
    getAttribute(name) {
      return ({ href: "/siteFormSubmitManage.jsp?formId=13", title: "查看结果", "aria-label": "查看结果" })[name] || "";
    },
    closest() { return row; },
    scrollIntoView() {},
    click() { clicks += 1; },
  };
  const document = {
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector.includes("a,button")) return [viewResults];
      return [];
    },
  };
  await loadExtensionScript("../fanke-helper/fanke-scraper.js", {
    chrome: { runtime: { onMessage: messages.event, sendMessage: async () => ({ ok: true }) } },
    document,
    location: { href: "https://i.jz.fkw.com/?siteId=0&_item=manageFrameFormManage", hostname: "i.jz.fkw.com" },
  });

  const response = await messages.dispatch({ type: "FANKE_HELPER_OPEN_RESULTS", formId: "13" });
  assert.equal(response?.accepted, true);
  assert.equal(clicks, 1, "the matching 查看结果 action must be opened automatically");
});

test("returns a reused Fanke result list to page one before collection", async () => {
  const messages = extensionMessageEvent();
  const row = {
    textContent: "2026-08-20 12:00:00 学校A",
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const activePage = {
    textContent: "3",
    className: "active",
    getAttribute(name) { return name === "aria-current" ? "page" : ""; },
    matches() { return false; },
  };
  const firstPage = {
    textContent: "1",
    className: "",
    getAttribute() { return ""; },
    matches() { return false; },
    scrollIntoView() {},
    click() {
      activePage.className = "";
      firstPage.className = "active";
      row.textContent = "2026-08-30 09:00:00 学校B";
    },
  };
  const pagination = { querySelectorAll: () => [firstPage, activePage] };
  const document = {
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === ".jz-table-body .jz-table-row") return [row];
      if (selector.includes("pagination") || selector.includes("Pagination") || selector.includes("分页")) return [pagination];
      return [];
    },
  };
  await loadExtensionScript("../fanke-helper/fanke-scraper.js", {
    chrome: { runtime: { onMessage: messages.event, sendMessage: async () => ({ ok: true }) } },
    document,
    location: { href: "https://i.jz.fkw.com/siteFormSubmitManage.jsp?formId=13", hostname: "i.jz.fkw.com" },
  });

  const response = await messages.dispatch({ type: "FANKE_HELPER_PREPARE", formId: "13" });
  assert.equal(response?.accepted, true);
  assert.equal(response?.page, 1);
  assert.equal(firstPage.className, "active");
});

test("starts Fanke collection from only a logged-in tab by opening and preparing a dedicated result page", async () => {
  const messages = extensionMessageEvent();
  const sent = [];
  const created = [];
  const injected = [];
  let openedResults = false;
  const chrome = {
    runtime: { onMessage: messages.event },
    tabs: {
      async query(query) {
        if (JSON.stringify(query).includes("fkw.com")) return [{ id: 7, url: "https://i.jz.fkw.com/", active: true, status: "complete", windowId: 1 }];
        return [];
      },
      async create(options) {
        created.push(options);
        return { id: 8, url: options.url, active: options.active, status: "complete", windowId: 1 };
      },
      async get(tabId) { return { id: tabId, status: "complete", url: created[0]?.url || "https://i.jz.fkw.com/" }; },
      async sendMessage(tabId, message, options) {
        sent.push({ tabId, message, options });
        if (tabId === 7) return null;
        if (message.type === "FANKE_HELPER_PROBE") return openedResults ? { ready: true } : { ready: false, manager: true };
        if (message.type === "FANKE_HELPER_OPEN_RESULTS") { openedResults = true; return { accepted: true }; }
        if (message.type === "FANKE_HELPER_PREPARE") return { accepted: true, page: 1 };
        if (message.type === "FANKE_HELPER_COLLECT") return { accepted: true };
        return null;
      },
      async update() {},
      onUpdated: { addListener() {}, removeListener() {} },
    },
    webNavigation: {
      async getAllFrames({ tabId }) {
        if (tabId === 7) return [{ frameId: 0, url: "https://i.jz.fkw.com/" }];
        return [{ frameId: 0, url: openedResults ? "https://i.jz.fkw.com/siteFormSubmitManage.jsp?formId=13" : created[0].url }];
      },
    },
    scripting: { async executeScript(options) { injected.push(options); } },
    windows: { async update() {} },
  };
  await loadExtensionScript("../fanke-helper/background.js", { chrome });

  const response = await messages.dispatch({
    type: "FANKE_HELPER_START",
    requestId: "scan-auto-page",
    formId: "13",
    startsAt: "2026-07-01",
    targetKind: "registration",
  }, { url: "https://chem-e-car-registration.clever-morel-6302.chatgpt.site/", tab: { id: 99, url: "https://chem-e-car-registration.clever-morel-6302.chatgpt.site/" } });

  assert.equal(response?.accepted, true);
  assert.equal(created.length, 1);
  assert.match(created[0].url, /manageFrameFormManage/);
  assert.ok(injected.some((entry) => entry.files?.includes("fanke-scraper.js")));
  assert.deepEqual(sent.filter((entry) => ["FANKE_HELPER_OPEN_RESULTS", "FANKE_HELPER_PREPARE", "FANKE_HELPER_COLLECT"].includes(entry.message.type)).map((entry) => entry.message.type), [
    "FANKE_HELPER_OPEN_RESULTS",
    "FANKE_HELPER_PREPARE",
    "FANKE_HELPER_COLLECT",
  ]);
});

test("injects the AliMail helper into an already logged-in inbox without requiring a refresh", async () => {
  const messages = extensionMessageEvent();
  let injected = false;
  const chrome = {
    runtime: { onMessage: messages.event },
    tabs: {
      async query() { return [{ id: 5, url: "https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all", active: true, status: "complete", windowId: 2 }]; },
      async sendMessage(_tabId, message) {
        if (!injected) throw new Error("receiving end does not exist");
        if (message.type === "CHEMECAR_ALIMAIL_FILL_DRAFTS") return { ok: true, saved: 1, created: 1 };
        return { ready: true };
      },
      async update() {},
    },
    scripting: { async executeScript(options) { assert.ok(options.files.includes("alimail-draft.js")); injected = true; } },
    webNavigation: { async getAllFrames() { return []; } },
    windows: { async update() {} },
  };
  await loadExtensionScript("../fanke-helper/background.js", { chrome });

  const response = await messages.dispatch({ type: "FANKE_HELPER_ALIMAIL_DRAFTS", drafts: [{
    schoolName: "天津大学",
    recipient: "team@example.edu.cn",
    subject: "报名回执",
    body: "天津大学参赛队：\n你好！",
  }] }, { url: "https://chem-e-car-registration.clever-morel-6302.chatgpt.site/" });

  assert.equal(response.ok, true);
  assert.equal(response.saved, 1);
  assert.equal(injected, true);
});

test("starts an AliMail media scan from an already logged-in inbox", async () => {
  const messages = extensionMessageEvent();
  let injected = false;
  let started = null;
  const inboxTab = { id: 7, url: "https://qiye.aliyun.com/alimail/entries/v5.1/mail/inbox/all", active: false, status: "complete", windowId: 2 };
  const chrome = {
    runtime: { onMessage: messages.event },
    tabs: {
      async query() { return [inboxTab]; },
      async get() { return inboxTab; },
      async sendMessage(_tabId, message) {
        if (!injected) throw new Error("receiving end does not exist");
        if (message.type === "CHEMECAR_ALIMAIL_COLLECTOR_PROBE") return { ready: true, state: "inbox_ready", mailboxKey: "team@example.edu.cn" };
        if (message.type === "CHEMECAR_ALIMAIL_SCAN_START") { started = message; return { accepted: true }; }
        return null;
      },
      async update() {},
      async create() { throw new Error("the logged-in inbox must be reused"); },
    },
    scripting: { async executeScript(options) { assert.ok(options.files.includes("alimail-collector.js")); injected = true; } },
    webNavigation: { async getAllFrames() { return []; } },
  };
  await loadExtensionScript("../fanke-helper/background.js", { chrome });

  const response = await messages.dispatch({
    type: "CHEMECAR_ALIMAIL_SCAN_START",
    requestId: "mail-scan-1",
    kind: "poster",
    startsAt: "2026-08-01",
  }, { url: "https://chem-e-car-registration.clever-morel-6302.chatgpt.site/", tab: { id: 99 } });

  assert.equal(response.accepted, true);
  assert.equal(injected, true);
  assert.equal(started.kind, "poster");
});

test("Fanke helper and media workspaces only expose registration and EDP", async () => {
  const [dashboard, helper, background, collector] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/fanke-scraper.js", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/background.js", import.meta.url), "utf8"),
    readFile(new URL("../worker/fanke-collector.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(dashboard, /<FankeControls[^>]+kind=\{activeMediaKind\}/s);
  assert.match(helper, /\["registration",\s*"edp"\]\.includes\(message\.targetKind\)/);
  assert.match(background, /\["registration",\s*"edp"\]\.includes\(message\.targetKind\)/);
  assert.match(collector, /export type FankeCollectibleKind = "registration" \| "edp"/);
  assert.match(collector, /海报和视频请使用阿里邮箱采集/u);
});

test("browser AliMail classification is conservative and migration preserves media", async () => {
  const [source, fileMetadataSource, mediaMigration, browserMigration, schema, journal] = await Promise.all([
    readFile(new URL("../worker/browser-mail-media.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/file-metadata.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_shared_media.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0014_browser_mail_media.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
  const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 };
  const fileMetadataOutput = ts.transpileModule(fileMetadataSource, {
    compilerOptions,
    fileName: "file-metadata.ts",
  }).outputText;
  const fileMetadataUrl = `data:text/javascript;base64,${Buffer.from(fileMetadataOutput).toString("base64")}`;
  const output = ts.transpileModule(source, {
    compilerOptions,
    fileName: "browser-mail-media.ts",
  }).outputText
    .replaceAll('"./file-metadata"', JSON.stringify(fileMetadataUrl))
    .replaceAll("'./file-metadata'", JSON.stringify(fileMetadataUrl));
  const browserMail = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);

  assert.equal(browserMail.classifyBrowserMailAttachment({
    filename: "天津大学-海报.zip",
    subject: "作品资料",
    contentType: "application/zip",
  }).kind, "poster");
  assert.equal(browserMail.classifyBrowserMailAttachment({
    filename: "天津大学.zip",
    subject: "作品资料",
    contentType: "application/zip",
  }).kind, null);
  assert.equal(browserMail.classifyBrowserMailAttachment({
    filename: "天津大学-宣传视频.mp4",
    subject: "视频提交",
    contentType: "video/mp4",
  }).kind, "video");
  assert.match(schema, /export const browserMailScanCheckpoints/);
  assert.match(schema, /export const browserMailSeenAttachments/);
  assert.ok(JSON.parse(journal).entries.some((entry) => entry.tag === "0014_browser_mail_media"));

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "browser-mail-migration-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const migration of [mediaMigration, browserMigration]) {
      for (const statement of migration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
      if (migration === mediaMigration) {
        await database.prepare(`INSERT INTO shared_media_assets (
          user_id, kind, school_key, school_name, r2_key, filename, content_type, size,
          submitted_at, submission_id, uploaded_at
        ) VALUES (?, 'poster', ?, ?, ?, ?, 'image/jpeg', 1, ?, ?, ?)`)
          .bind("shared-browser-workspace", "tianjin", "天津大学", "poster/tianjin.jpg", "天津大学-海报.jpg", "2026-08-01T00:00:00.000Z", "1", "2026-08-01T00:00:00.000Z")
          .run();
      }
    }
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM shared_media_assets").first()).total, 1);
    assert.ok(await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_mail_scan_checkpoints'").first());
    assert.ok(await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_mail_seen_attachments'").first());
  } finally {
    await miniflare.dispose();
  }
});

test("browser mail scan API is authenticated, date-bounded, and restores deleted assets", async () => {
  const [worker, cookie] = await Promise.all([loadWorker(), authenticatedCookie()]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "browser-mail-api-test" },
  });
  const files = new FakeR2();
  try {
    const database = await miniflare.getD1Database("DB");
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const anonymous = await callApi(worker, env, "/api/mail-browser/state", { origin: AUTH_ORIGIN });
    assert.equal(anonymous.status, 401);

    const settings = await callApi(worker, env, "/api/media-settings/poster", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsAt: "2026-08-01",
        runTime: "09:00",
        timezone: "Asia/Shanghai",
        intervalMinutes: 1440,
        enabled: false,
      }),
    });
    assert.equal(settings.status, 200);

    const start = await callApi(worker, env, "/api/mail-browser/scans/start", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanId: "scan-browser-1", kind: "poster", mailboxKey: "alimail-inbox" }),
    });
    assert.equal(start.status, 200);

    const messages = [{
      messageKey: "mail-100",
      subject: "参赛资料",
      receivedAt: "2026-08-02T10:00:00.000Z",
      attachments: [
        { fingerprint: "poster-new", filename: "天津大学-海报.jpg", contentType: "image/jpeg", size: 1024, sourceRef: "alimail:mail-100:0" },
        { fingerprint: "archive-ambiguous", filename: "天津大学.zip", contentType: "application/zip", size: 2048, sourceRef: "alimail:mail-100:1" },
        { fingerprint: "poster-too-large", filename: "北京大学-海报.jpg", contentType: "image/jpeg", size: 209715201, sourceRef: "alimail:mail-100:2" },
      ],
    }, {
      messageKey: "mail-90",
      subject: "海报提交",
      receivedAt: "2026-07-31T10:00:00.000Z",
      attachments: [
        { fingerprint: "poster-before-cutoff", filename: "南开大学-海报.jpg", contentType: "image/jpeg", size: 512, sourceRef: "alimail:mail-90:0" },
      ],
    }];
    const batchRequest = () => callApi(worker, env, "/api/mail-browser/scans/batch", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanId: "scan-browser-1", kind: "poster", mailboxKey: "alimail-inbox", messages }),
    });
    const batch = await batchRequest();
    assert.equal(batch.status, 200);
    const payload = await batch.json();
    assert.deepEqual(payload.results.map((row) => row.action), ["upload", "candidate", "reject", "skip"]);
    assert.equal(payload.results[0].schoolName, "天津大学");

    const upload = payload.results[0];
    const r2Key = "browser-mail/poster/tianjin/current";
    await database.prepare(`INSERT INTO shared_media_assets (
      user_id, kind, school_key, school_name, r2_key, filename, content_type, size,
      submitted_at, submission_id, uploaded_at, source, source_ref
    ) VALUES (?, 'poster', ?, ?, ?, ?, 'image/jpeg', ?, ?, ?, ?, 'web', NULL)`)
      .bind("shared-browser-workspace", upload.schoolKey, upload.schoolName, r2Key, upload.filename, upload.size, upload.submittedAt, upload.submissionId, "2026-08-02T10:01:00.000Z")
      .run();
    files.seedBytes(r2Key, new Uint8Array([0xff, 0xd8, 0xff]));

    const finish = await callApi(worker, env, "/api/mail-browser/scans/finish", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scanId: "scan-browser-1",
        kind: "poster",
        mailboxKey: "alimail-inbox",
        lastMessageKey: "mail-90",
        uploadedFingerprints: ["poster-new"],
      }),
    });
    assert.equal(finish.status, 200);
    assert.equal((await database.prepare("SELECT status FROM browser_mail_seen_attachments WHERE fingerprint = 'poster-new'").first()).status, "uploaded");

    const duplicate = await batchRequest();
    assert.equal((await duplicate.json()).results[0].action, "skip");
    await database.prepare("DELETE FROM shared_media_assets WHERE user_id = ? AND kind = 'poster' AND school_key = ?")
      .bind("shared-browser-workspace", upload.schoolKey).run();
    await files.delete(r2Key);
    const restored = await batchRequest();
    assert.equal((await restored.json()).results[0].action, "upload");

    const state = await callApi(worker, env, "/api/mail-browser/state", { origin: AUTH_ORIGIN, cookie });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).checkpoints[0].kind, "poster");
  } finally {
    await miniflare.dispose();
  }
});

test("AliMail collector helper navigates from login and only reads media attachments", async () => {
  const [manifestSource, background, bridge, collector] = await Promise.all([
    readFile(new URL("../fanke-helper/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/background.js", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/site-bridge.js", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/alimail-collector.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const aliMailScript = manifest.content_scripts.find((entry) => entry.matches.includes("https://qiye.aliyun.com/*"));
  assert.ok(aliMailScript.js.includes("alimail-collector.js"));
  assert.ok(compareVersions(
    { submitted_at: "1970-01-01T00:00:00.000Z", submission_id: manifest.version.replaceAll(".", "") },
    { submitted_at: "1970-01-01T00:00:00.000Z", submission_id: "146" },
  ) > 0);
  assert.ok(background.indexOf('chrome.tabs.query({ url: ["https://qiye.aliyun.com/*"] })') < background.indexOf("chrome.tabs.create({ url: ALIMAIL_INBOX_URL"));
  for (const message of [
    "CHEMECAR_ALIMAIL_COLLECTOR_PROBE",
    "CHEMECAR_ALIMAIL_SCAN_START",
    "CHEMECAR_ALIMAIL_SCAN_PROGRESS",
    "CHEMECAR_ALIMAIL_SCAN_DONE",
    "CHEMECAR_ALIMAIL_SCAN_ERROR",
  ]) {
    assert.match(`${background}\n${bridge}\n${collector}`, new RegExp(message));
  }
  assert.match(collector, /8 \* 1024 \* 1024/);
  assert.match(collector, /credentials: "include"/);
  assert.match(bridge, /CHEMECAR_ALIMAIL_API_REQUEST/);
  assert.doesNotMatch(collector, /markAsRead|moveMessage|deleteMessage|sendMail|method:\s*["']DELETE["']/iu);
});

test("media workspaces use AliMail schedules and keep manual file management", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /function AliMailMediaControls/);
  assert.match(dashboard, /<AliMailMediaControls[\s\S]+kind=\{activeMediaKind\}[\s\S]+onScanNow=\{\(\) => void startAliMailMediaScan\(activeMediaKind\)\}/u);
  assert.match(dashboard, /阿里邮箱自动收取/u);
  assert.match(dashboard, /浏览器关闭后暂停；重新登录后继续/u);
  assert.match(dashboard, /CHEMECAR_ALIMAIL_SCAN_START/);
  assert.match(dashboard, /window\.setInterval\(runDueScan/u);
  assert.match(dashboard, /\/api\/mail-browser\/state/);
  assert.match(dashboard, /立即扫描/);
  assert.doesNotMatch(dashboard, /<FankeControls[^>]+kind=\{activeMediaKind\}/s);
  assert.match(dashboard, /BulkFileActions/);
  assert.match(dashboard, /保存到本地/);
  assert.match(dashboard, /批量删除所选/);
  for (const selector of [".alimail-media-controls", ".alimail-media-schedule", ".alimail-media-status", ".alimail-media-help"]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
});

test("EDP audit workspace separates automatic review, preview and optional single or batch downloads", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /type Workspace = "registration" \| "edp" \| "edpReview" \| "mail" \| "poster" \| "video"/);
  assert.match(dashboard, /EDP 审核/);
  assert.match(dashboard, /\/api\/edp-reviews\/settings/);
  assert.match(dashboard, /\/api\/edp-reviews/);
  assert.match(dashboard, /\/api\/edp-reviews\/export-batch/);
  assert.match(dashboard, /\/api\/edp-reviews\/process-next/);
  assert.doesNotMatch(dashboard, /auditAndDownloadEdpReviews/);
  for (const label of ["全选本栏", "下载所选结果", "一键下载全部已完成", "查看审核结果", "重新审核所选", "待人工确认"]) {
    assert.match(dashboard, new RegExp(label));
  }
  assert.match(dashboard, /删除此 EDP/u);
  assert.match(dashboard, /deleteEdpReviewSubmission/u);
  assert.match(dashboard, /method:\s*"DELETE"/u);
  assert.doesNotMatch(dashboard, /保存本项/);
  assert.doesNotMatch(dashboard, /确认审核结论/);
  assert.match(dashboard, /role="dialog"/);
  assert.match(dashboard, /aria-modal="true"/);
  for (const selector of [".edp-review-settings", ".edp-review-list", ".edp-review-bulk-actions", ".edp-review-dialog", ".edp-review-evidence"]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
});

test("EDP audit workspace groups cross-document evidence with Chinese-template exemption wording", async () => {
  const dashboard = await readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8");
  for (const label of [
    "英文版危险分析",
    "英文版实验室平面图",
    "英文版主要危险清单",
    "化学物质、Chemical Information 与 SDS 一致性",
    "参赛成员与指导教师安全培训证书",
    "设备清单与制造商资料",
    "氢气/可燃物排放计算适用性",
    "压力计算适用性",
    "车辆资本成本完整性",
    "废物流与 Team Waste Tags 一致性",
  ]) assert.match(dashboard, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(dashboard, /英文版专属安全章节/u);
  assert.match(dashboard, /中文版模板不含这些章节/u);
  assert.match(dashboard, /化学品、设备与增补文件/u);
  assert.match(dashboard, /计算、成本与废物/u);
});

test("renders annual EDP rule and grouped review UI", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const workspace = dashboard.slice(dashboard.indexOf('id="edpReview-workspace"'), dashboard.indexOf('id="mail-workspace"'));
  const annualRules = workspace.indexOf("年度竞赛规则");
  const reviewSettings = workspace.indexOf("审核意见表设置");
  const latestJobs = workspace.indexOf("每校最新审核任务");
  assert.ok(annualRules >= 0 && annualRules < reviewSettings && reviewSettings < latestJobs, "annual rules, settings, and review jobs must appear in operator order");
  for (const endpoint of [
    "/api/edp-rule-documents",
    "/activate",
    "/download",
    "/recheck-latest",
  ]) assert.match(dashboard, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const label of [
    "上传并解析规则 PDF",
    "检测年份",
    "候选规则事实",
    "变化摘要",
    "确认并启用",
    "下载原规则",
    "按当前启用规则另建复核",
    "首页与报名信息",
    "工作安全评估",
    "标准安全操作",
    "近五年方案",
    "其他规则",
    "影响正式结论",
    "提示项",
    "规则来源",
  ]) assert.match(dashboard, new RegExp(label));
  assert.match(dashboard, /item\.isBlocking/);
  assert.match(dashboard, /item\.ruleSource/);
  for (const selector of [".edp-rule-card", ".edp-rule-history", ".edp-review-group", ".edp-review-rule-meta"]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
  assert.match(css, /@media \(max-width:680px\)[\s\S]*\.edp-rule-actions/u);
});

test("console exposes seven focused workspaces and consolidated collection help", async () => {
  const dashboard = await readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /function CollectionHelpDisclosure/);
  assert.doesNotMatch(dashboard, /function FileManagementHelp/);
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
  assert.match(dashboard, /<details className="collection-help-disclosure"/);
  assert.match(dashboard, /收集、保存与删除说明/);
  assert.match(dashboard, /从共享云端删除后，再次增量收集会按“云端是否存在”重新下载/);
  assert.match(dashboard, /<details className="mail-advanced-disclosure"/);
  assert.match(dashboard, /<details className="mail-records-disclosure"/);
});

test("console uses the calm responsive visual system", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const token of [
    "--ink-strong:#0b2344",
    "--ink:#123b6d",
    "--ink-muted:#60748c",
    "--surface:#ffffff",
    "--surface-soft:#f3f7fc",
    "--surface-blue:#eef5ff",
    "--line:#d5e0ed",
    "--brand:#246bce",
    "--brand-strong:#123b6d",
    "--success:#0f766e",
    "--warning:#a15c00",
    "--danger:#b42318",
    "--radius-card:18px",
    "--control-height:46px",
  ]) {
    assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(css, /min-height:var\(--control-height\)/);
  assert.match(css, /@media \(max-width:680px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(css, /scroll-behavior:auto/);
  assert.match(css, /\.collection-help-disclosure/);
});

test("EDP workspaces expose multi-format status and fixed review settings", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /accept="\.zip,\.7z,\.rar,application\/zip,application\/x-7z-compressed,application\/vnd\.rar"/);
  for (const label of [
    "压缩格式",
    "提交轮次",
    "中文版 EDP",
    "英文版 EDP",
    "EDP 增补文件",
    "MOC",
    "报名表联动",
    "审核任务已建立",
    "审核任务待补建",
    "解压完成",
    "已识别并读取",
    "逐份打开并验证 PDF",
    "Word、损坏或伪装成 PDF",
    "未入库",
    "同步并刷新审核任务",
    "已补建",
    "已有任务",
    "补建失败",
    "安全与规则审查人",
    "潘芳丽",
    "安全与规则审查人邮箱",
    "service@chemecar.cn",
    "专家组成员",
    "华炜",
    "待审核",
    "审核中",
    "待人工确认",
    "已完成",
    "待补建",
  ]) assert.match(dashboard, new RegExp(label));

  assert.match(dashboard, /\/api\/edp-reviews\/sync/);
  assert.match(dashboard, /<select required value=\{edpReviewSettings\.competitionYear\}/);
  assert.doesNotMatch(dashboard, /专家组成员邮箱/);
  assert.match(dashboard, /key=\{`\$\{item\.schoolKey\}-\$\{item\.submissionId\}`\}/);
  assert.match(dashboard, /key=\{job\.jobId\}/);
  assert.doesNotMatch(dashboard, /sortedEdpIssues\.map\(\(item, index\)/);
  assert.match(dashboard, /className="edp-issue-scroll" role="region" aria-label="全部 EDP 文件问题" tabIndex=\{0\}/);
  assert.match(css, /\.edp-issue-scroll \{[^}]*max-height:34rem[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/s);
  assert.match(css, /button,select,textarea,input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\) \{ min-height:44px; \}/);
});

test("declares seven shared workspaces, keeps navigation in the rail, and uses larger bold typography", async () => {
  const [dashboard, worker, mailApi, fankeCollector, registrationWorkbook, schema, edpMigration, mediaMigration, mailMigration, founderMigration, mailMediaMigration, mediaArchiveMigration, fankeMigration, fankeAssistantMigration, fankeCategoryMigration, receiptMigration, edpReceiptMigration, helperManifest, helperBackground, helperBridge, helperAlibaba, helperScraper, layout, css, vite] = await Promise.all([
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/mail-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/fanke-collector.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/registration-workbook.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_edp_collector.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_shared_media.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_alibaba_mail_collector.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_founder_shared_password.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_mail_media_candidates.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_media_archives_schedules.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0008_fanke_collector.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0009_fanke_one_click_assistant.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0010_fanke_category_scans.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0011_registration_receipts.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0012_edp_receipts.sql", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/background.js", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/site-bridge.js", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/alimail-draft.js", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/fanke-scraper.js", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /const title = "Chem-E-Car 赛事资料共享中心"/);
  assert.match(layout, /og-shared-center\.png/);
  assert.match(dashboard, /type Workspace = "registration" \| "edp" \| "edpReview" \| "mail" \| "poster" \| "video" \| "certificate"/);
  assert.match(dashboard, /className="collector-rail"/);
  assert.match(dashboard, /\/api\/edp-settings/);
  assert.match(dashboard, /\/api\/edp-submissions/);
  assert.match(dashboard, /\/api\/mail-settings/);
  assert.match(dashboard, /\/api\/mail-test/);
  assert.match(dashboard, /\/api\/mail-sync/);
  assert.match(dashboard, /`\/api\/media\/\$\{kind\}/);
  assert.ok(dashboard.includes("/api/media-settings/"));
  assert.match(dashboard, /只收集此日期及之后/);
  assert.match(dashboard, /multipart\/create/);
  assert.match(dashboard, /\/api\/fanke\/assistant\/start/);
  assert.match(dashboard, /\/api\/fanke\/assistant\/ingest/);
  assert.match(dashboard, /\/api\/fanke\/assistant\/finish/);
  assert.match(dashboard, /\/api\/fanke\/collect\/\$\{kind\}/);
  assert.match(dashboard, /一键增量收集\$\{label\}/);
  assert.match(dashboard, /或已从共享云端删除的\{label\}文件/);
  assert.match(dashboard, /chemecar-fanke-helper\.zip/);
  assert.match(dashboard, /REQUIRED_FANKE_HELPER_VERSION = "1\.5\.0"/);
  assert.match(dashboard, /ALIMAIL_DRAFT_BATCH_SIZE = 5/);
  assert.match(dashboard, /function isValidReceiptEmail/);
  assert.match(dashboard, /isValidReceiptEmail\(item\.receipt\.recipientEmail\)/);
  assert.match(dashboard, /recipient: normalizeReceiptEmail\(item\.receipt\.recipientEmail\)/);
  assert.match(dashboard, /邮箱格式不正确而自动跳过/);
  assert.match(dashboard, /currentBatch = eligible\.slice\(offset, offset \+ ALIMAIL_DRAFT_BATCH_SIZE\)/);
  assert.match(dashboard, /助手正在自动打开下一封/);
  assert.match(dashboard, /zh-CN-u-co-pinyin/);
  assert.match(dashboard, /sortedRegistrations\.map/);
  assert.match(dashboard, /栏目收集起始日期/);
  assert.match(dashboard, /修改后自动保存/);
  assert.doesNotMatch(dashboard, /<span>日期所属时区<\/span>/);
  assert.match(dashboard, /targetKind: kind/);
  assert.match(dashboard, /BulkFileActions/);
  assert.match(dashboard, /批量删除所选/);
  assert.match(dashboard, /采集文件保存在本站共享云端/);
  assert.match(dashboard, /\/api\/fanke\/problems\/\$\{kind\}/);
  assert.match(dashboard, /不会自动存进当前电脑/);
  assert.match(dashboard, /只需选择文件；系统从文件名识别学校/);
  assert.match(dashboard, /保存到本地/);
  assert.match(dashboard, /window\.confirm/);
  assert.match(dashboard, /\/api\/registration-receipt-settings/);
  assert.match(dashboard, /\/api\/edp-receipt-settings/);
  assert.match(dashboard, /本轮 EDP 提交次数（必填）/);
  assert.match(dashboard, /一键写入全部最新 EDP 回执/);
  assert.match(dashboard, /latestEdpReceiptItems/);
  assert.match(dashboard, /查看回执/);
  assert.match(dashboard, /复制邮件正文/);
  assert.match(dashboard, /一键写入阿里邮箱草稿/);
  assert.match(dashboard, /一键逐封写入全部已生成回执/);
  assert.match(dashboard, /FANKE_HELPER_ALIMAIL_DRAFTS/);
  assert.match(dashboard, /收件人、主题和正文分别写入阿里邮箱草稿/);
  assert.match(dashboard, /旧版检查结果已停用，需要重新核对/);
  assert.match(dashboard, /重新检查当前文件/);
  assert.match(dashboard, /竞赛年份（必填）/);
  assert.match(dashboard, /交流 QQ 群号（必填）/);
  assert.match(dashboard, /fanke\.problemFiles \|\| fanke\.recentFiles/);
  assert.doesNotMatch(dashboard, /\.slice\(0, 5\)/);
  for (const label of ["报名表统计", "EDP 提交统计", "EDP 审核", "阿里邮箱连接", "海报收集", "视频收集", "证书制作"]) {
    assert.match(dashboard, new RegExp(label));
  }
  assert.match(worker, /url\.pathname === "\/api\/edp-settings"/);
  assert.match(worker, /url\.pathname === "\/api\/edp-submissions"/);
  assert.match(worker, /url\.pathname === "\/api\/mail-settings"/);
  assert.match(worker, /url\.pathname === "\/api\/mail-test"/);
  assert.match(worker, /url\.pathname === "\/api\/mail-sync"/);
  assert.match(worker, /url\.pathname === "\/api\/registration-receipt-settings"/);
  assert.match(worker, /url\.pathname === "\/api\/edp-receipt-settings"/);
  assert.match(worker, /第\$\{settings\.submissionRound\}次提交应包含/);
  assert.match(worker, /EDP提交成功回执/);
  assert.match(worker, /refreshRegistrationReceipt/);
  assert.match(worker, /requiresReassessment = storedReasons\.some\(\(reason\) => \/第1048576行/u);
  assert.match(worker, /new File\(\[workbookBytes\], current\.filename/);
  assert.match(registrationWorkbook, /指导教师人数为\$\{teacherRoster\.count\}人，不能超过5人/);
  assert.match(registrationWorkbook, /学生人数为\$\{memberRoster\.count\}人，必须不少于5人且不超过15人/);
  assert.match(worker, /\/api\\\/media\\\/\(poster\|video\)/);
  assert.match(worker, /mediaMultipartCreate/);
  assert.match(worker, /mediaMultipartPart/);
  assert.match(worker, /mediaMultipartComplete/);
  assert.match(worker, /const edpDownload = url\.pathname\.match/);
  assert.match(worker, /if \(edpDownload\) return downloadEdpSubmission/);
  assert.match(worker, /const mediaDownload = url\.pathname\.match/);
  assert.match(worker, /const mailAttachmentDownload = url\.pathname\.match/);
  assert.match(worker, /const rawMailDownload = url\.pathname\.match/);
  assert.match(worker, /handleFankeWebhook/);
  assert.match(worker, /runDueFankeCollectors/);
  assert.match(worker, /startFankeAssistantScan/);
  assert.match(worker, /ingestFankeAssistantBatch/);
  assert.match(worker, /finishFankeAssistantScan/);
  assert.match(worker, /resolveFankeViewLink/);
  assert.match(worker, /文件名称\\s\*\[:：\]/);
  assert.match(worker, /clearFankeProblems/);
  assert.match(fankeCollector, /status IN \('retry','invalid'\)/);
  assert.match(fankeCollector, /ORDER BY submitted_at ASC, received_at ASC/);
  assert.match(fankeCollector, /problemFiles: problemQueue\.results\.map\(dashboardFile\)/);
  assert.match(fankeCollector, /SELECT kind, status, COUNT\(\*\) AS total FROM fanke_files/);
  assert.match(fankeCollector, /storedLibraryVersions/);
  assert.match(fankeCollector, /versionSubmissionId, file\.fileKey, targetRecord\.revisionHash/);
  for (const table of ["fanke_connectors", "fanke_files", "fanke_issues"]) {
    assert.match(fankeCollector, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(fankeMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  for (const table of ["fanke_assistant_submissions", "fanke_assistant_files", "fanke_assistant_runs"]) {
    assert.match(fankeCollector, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(fankeAssistantMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(schema, /export const fankeAssistantSubmissions/);
  assert.match(schema, /export const fankeAssistantFiles/);
  assert.match(schema, /export const fankeAssistantRuns/);
  assert.match(schema, /export const registrationReceiptSettings/);
  assert.match(schema, /export const registrationReceipts/);
  assert.match(receiptMigration, /CREATE TABLE `registration_receipt_settings`/);
  assert.match(receiptMigration, /CREATE TABLE `registration_receipts`/);
  assert.match(schema, /export const edpReceiptSettings/);
  assert.match(edpReceiptMigration, /CREATE TABLE `edp_receipt_settings`/);
  assert.match(edpReceiptMigration, /submission_round/);
  assert.match(schema, /targetKind: text\("target_kind"\)/);
  assert.match(fankeCategoryMigration, /ADD COLUMN `target_kind`/);
  assert.match(helperManifest, /"manifest_version": 3/);
  assert.match(helperManifest, /"version": "1\.5\.0"/);
  assert.match(helperManifest, /"scripting"/);
  assert.match(helperManifest, /https:\/\/\*\.fkw\.com\/\*/);
  assert.match(helperManifest, /https:\/\/qiye\.aliyun\.com\/\*/);
  assert.match(helperManifest, /alimail-draft\.js/);
  assert.match(helperBackground, /FANKE_HELPER_COLLECT/);
  assert.match(helperBackground, /FANKE_HELPER_ALIMAIL_DRAFTS/);
  assert.match(helperBackground, /CHEMECAR_ALIMAIL_FILL_DRAFTS/);
  assert.match(helperBackground, /startsAt: message\.startsAt/);
  assert.match(helperBackground, /targetKind: message\.targetKind/);
  assert.match(helperBridge, /event\.origin !== location\.origin/);
  assert.match(helperBridge, /startsAt: message\.startsAt/);
  assert.match(helperBridge, /targetKind: message\.targetKind/);
  assert.match(helperBridge, /FANKE_HELPER_ALIMAIL_RESULT/);
  assert.match(helperAlibaba, /未找到阿里邮箱的“写邮件”按钮/);
  assert.match(helperAlibaba, /chinese: "收件人", english: \/recipient/);
  assert.match(helperAlibaba, /chinese: "主题", english: \/subject/);
  assert.match(helperAlibaba, /\[role='\$\{aliases\.role\}'\]\[aria-label='\$\{aliases\.chinese\}'\]/);
  assert.match(helperAlibaba, /recipientRegionText/);
  assert.match(helperAlibaba, /fillAndVerifyField/);
  assert.match(helperAlibaba, /empty recipient input to zero width/);
  assert.match(helperAlibaba, /function fieldSurfaceVisible/);
  assert.match(helperAlibaba, /fieldSurfaceVisible\(candidate\)/);
  assert.match(helperAlibaba, /function findFieldFromTextLabel/);
  assert.match(helperAlibaba, /compactSemanticText\(element\.textContent \|\| ""\) === expected/);
  assert.match(helperAlibaba, /fieldVerticalDistance/);
  assert.match(helperAlibaba, /recipient !== subject/);
  assert.match(helperAlibaba, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(helperAlibaba, /currentValue === expectedEmail/);
  assert.match(helperAlibaba, /!field\.isConnected/);
  assert.match(helperAlibaba, /recipient: recipientCommitted/);
  assert.match(helperAlibaba, /function waitForStableBlankComposer/);
  assert.match(helperAlibaba, /function openComposerAutomatically/);
  assert.match(helperAlibaba, /await openComposerAutomatically\(\)/);
  assert.match(helperAlibaba, /draft\.schoolName/);
  assert.match(helperBackground, /schoolName: typeof draft\?\.schoolName/);
  assert.match(helperAlibaba, /阿里邮箱未能回读确认/);
  assert.match(helperAlibaba, /为防止生成空草稿，本次没有保存/);
  assert.match(helperAlibaba, /currentStatus !== initialSaveStatus/);
  assert.match(helperAlibaba, /存草稿/);
  assert.ok(helperAlibaba.indexOf("const verification") < helperAlibaba.indexOf("save.click()"), "draft fields must be verified before the save action");
  assert.doesNotMatch(helperAlibaba, /return \{ saved: false/u);
  assert.doesNotMatch(helperAlibaba, /\.click\(\)[\s\S]{0,80}发送/u);
  assert.match(helperScraper, /FANKE_HELPER_RECORDS/);
  assert.match(helperScraper, /fieldLabel/);
  assert.match(helperScraper, /\/view\\\.jsp\$/);
  assert.match(helperScraper, /searchParams\.get\("fileID"\)/);
  assert.match(helperScraper, /credentials: "include"/);
  assert.match(helperScraper, /dateOnly\(record\.submittedAt\) >= startsAt/);
  assert.match(helperScraper, /if \(reachedDateBoundary\) break/);
  assert.match(helperScraper, /\["registration", "edp"\]\.includes\(message\.targetKind\)/);
  assert.match(helperScraper, /download\\\.s\\d\+i\\\.co99\\\.net/);
  assert.match(helperScraper, /:scope > \.dd-handle/);
  assert.match(helperScraper, /Keep the empty checkbox column/);
  assert.match(registrationWorkbook, /MAX_ANALYZED_WORKBOOK_ROWS = 10_000/);
  assert.match(registrationWorkbook, /filledRequiredFields >= 2/);
  assert.doesNotMatch(worker, /（待用户补充）/u);
  assert.doesNotMatch(helperScraper, /querySelectorAll\("a,\[href\],\[src\]/);

  for (const table of ["edp_settings", "edp_submissions", "edp_issues"]) {
    assert.match(worker, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(edpMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(mediaMigration, /CREATE TABLE `shared_media_assets`/);
  assert.match(mailApi, /CREATE TABLE IF NOT EXISTS mail_settings/);
  for (const table of ["mail_settings", "mail_messages", "mail_attachments", "mail_issues"]) {
    assert.match(mailMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.match(schema, /export const edpSettings/);
  assert.match(schema, /export const edpSubmissions/);
  assert.match(schema, /export const edpIssues/);
  assert.match(schema, /export const sharedMediaAssets/);
  assert.match(schema, /export const mediaCollectorSettings/);
  assert.match(schema, /export const mediaUploadSessions/);
  assert.match(schema, /export const mailSettings/);
  assert.match(schema, /export const mailMessages/);
  assert.match(schema, /export const mailAttachments/);
  assert.match(schema, /export const mailIssues/);
  assert.match(schema, /export const appSecuritySettings/);
  assert.match(founderMigration, /CREATE TABLE `app_security_settings`/);
  assert.match(founderMigration, /CHECK\(`app_security_settings`\.`singleton_id` = 1\)/);
  assert.match(founderMigration, /CHECK\(`app_security_settings`\.`password_version` >= 1\)/);
  assert.match(worker, /CREATE TABLE IF NOT EXISTS app_security_settings/);
  assert.match(mailMediaMigration, /ALTER TABLE `shared_media_assets` ADD COLUMN `source`/);
  assert.match(mailMediaMigration, /CREATE TABLE `mail_media_candidates`/);
  assert.match(schema, /export const mailMediaCandidates/);
  assert.match(schema, /sourceRef: text\("source_ref"\)/);
  assert.match(schema, /primaryKey\(\{ columns: \[table\.userId, table\.schoolKey\] \}\)/);
  assert.match(mediaArchiveMigration, /CREATE TABLE `media_collector_settings`/);
  assert.match(mediaArchiveMigration, /CREATE TABLE `media_upload_sessions`/);
  assert.match(mediaArchiveMigration, /`size` > 0 AND `size` <= 209715200/);
  assert.match(vite, /triggers: \{ crons: \["\*\/5 \* \* \* \*"\] \}/);

  assert.match(css, /--blue-700:#1b5597/);
  assert.match(css, /--panel:var\(--surface\)/);
  assert.match(css, /--font-ui:"Arial Black","Microsoft YaHei","微软雅黑","SimHei","黑体"/);
  assert.match(css, /body \{[^}]*font-family:var\(--font-ui\)[^}]*font-size:18px[^}]*font-weight:700/);
  assert.match(css, /button,input,select,textarea,option,optgroup \{ font:inherit; font-weight:700; \}/);
  assert.match(css, /input::file-selector-button \{ font-family:inherit; \}/);
  assert.match(dashboard, /无法连接服务器。请确认已开启 VPN\/网络代理，然后刷新页面重试。/);
  assert.doesNotMatch(dashboard, /访问前请确认网络代理|NetworkProxyReminder|workspace-gateway|workspace-choice/);
  assert.doesNotMatch(css, /network-proxy-reminder|workspace-gateway|workspace-choice|gateway-copy/);
  assert.match(dashboard, /重置密码（非必要不重置）/);
  assert.match(css, /\.rail-link \{ font-size:16px; font-weight:800; \}/);
  assert.match(css, /\.record-meta \{ font-size:15px; \}/);
  assert.match(css, /\.console-notice \{[^}]*position:sticky[^}]*top:12px[^}]*z-index:45/s);
  assert.match(css, /\.fanke-problem-list \{[^}]*max-height:430px[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/s);
});

test("packages the Fanke and Alibaba Mail collectors in the downloadable helper", async () => {
  const archive = await JSZip.loadAsync(await readFile(new URL("../public/chemecar-fanke-helper.zip", import.meta.url)));
  const expectedFiles = ["manifest.json", "background.js", "site-bridge.js", "fanke-scraper.js", "alimail-draft.js", "alimail-collector.js", "安装说明.txt"];
  assert.deepEqual(Object.keys(archive.files).sort(), expectedFiles.sort());
  const manifest = JSON.parse(await archive.file("manifest.json").async("string"));
  assert.equal(manifest.version, "1.5.0");
  assert.ok(manifest.host_permissions.includes("https://qiye.aliyun.com/*"));
  const guide = await archive.file("安装说明.txt").async("string");
  assert.match(guide, /EDP 审核与 Excel/);
  for (const statement of [
    "EDP 支持 ZIP、7z、RAR",
    "压缩包可以先包含一个学校目录",
    "随包报名表",
    "加密压缩包",
    "同步并刷新审核任务",
    "绝不会自动发送邮件",
  ]) assert.match(guide, new RegExp(statement));
});

test("documents the seven-workspace operator flow and strict EDP review boundaries", async () => {
  const [readme, helperGuide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../fanke-helper/安装说明.txt", import.meta.url), "utf8"),
  ]);
  for (const text of [readme, helperGuide]) {
    assert.match(text, /凡科.*报名表.*EDP/s);
    assert.match(text, /阿里邮箱.*海报.*视频/s);
    assert.match(text, /不会自动发送/);
    assert.match(text, /EDP 支持 ZIP、7z、RAR/);
    assert.match(text, /压缩包可以先包含一个学校目录/);
    assert.match(text, /随包报名表/);
    assert.match(text, /加密压缩包/);
    assert.match(text, /同步并刷新审核任务/);
  }
  assert.match(readme, /七个工作区/);
  assert.match(readme, /是、否、不适用、待人工确认/);
  assert.match(readme, /草稿 Excel/);
  assert.match(readme, /正式 Excel/);
  assert.match(readme, /删除后.*重新收集/s);
  assert.match(readme, /不会删除、移动或标记原邮件/);
  assert.match(helperGuide, /EDP 审核与 Excel/);
});

test("EDP audit template keeps both sheets and required merge ranges", async () => {
  const bytes = await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url));
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await zip.file("xl/workbook.xml").async("text");
  assert.match(workbookXml, /name="1\) EDP Cover Page"/u);
  assert.match(workbookXml, /name="2\) EDP Evaluation"/u);
  const coverXml = await zip.file("xl/worksheets/sheet1.xml").async("text");
  const evaluationXml = await zip.file("xl/worksheets/sheet2.xml").async("text");
  for (const merge of ["A1:E1", "C13:E13", "K13:M13", "D23:E24"]) assert.match(coverXml, new RegExp(`mergeCell ref="${merge}"`));
  for (const merge of ["A1:D1", "A17:C17", "A42:C42"]) assert.match(evaluationXml, new RegExp(`mergeCell ref="${merge}"`));
});

test("0015 EDP review migration preserves submissions and constrains item status", async () => {
  const [edpMigration, reviewMigration, schema, journalSource] = await Promise.all([
    readFile(new URL("../drizzle/0001_edp_collector.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0015_edp_reviews.sql", import.meta.url), "utf8").catch(() => ""),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
  assert.match(reviewMigration, /CREATE TABLE `edp_review_jobs`/u);
  assert.match(reviewMigration, /'yes','no','not_applicable','needs_human'/u);
  assert.match(schema, /export const edpReviewSettings/u);
  assert.match(schema, /export const edpReviewJobs/u);
  assert.match(schema, /export const edpReviewItems/u);
  assert.match(schema, /export const edpReviewExports/u);
  assert.ok(JSON.parse(journalSource).entries.some(({ tag }) => tag === "0015_edp_reviews"));

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "edp-review-migration-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const migration of [edpMigration, reviewMigration]) {
      for (const statement of migration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
      if (migration === edpMigration) {
        await database.prepare(`INSERT INTO edp_submissions (
          user_id, school_key, school_name, r2_key, filename, content_type, submitted_at,
          submission_id, size, file_count, uploaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind("shared-review-workspace", "tianjin", "天津大学", "edp/tianjin.zip", "天津大学-EDP.zip", "application/zip", "2026-08-01T00:00:00.000Z", "100", 1024, 3, "2026-08-01T00:01:00.000Z")
          .run();
      }
    }
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_submissions").first()).total, 1);
    await database.prepare(`INSERT INTO edp_review_jobs (
      user_id, job_id, school_key, school_name, submission_id, submitted_at, submission_round,
      rule_version, template_version, status, overall_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("shared-review-workspace", "job-1", "tianjin", "天津大学", "100", "2026-08-01T00:00:00.000Z", 1, "v1", "v1", "queued", "pending", "2026-08-01T00:02:00.000Z", "2026-08-01T00:02:00.000Z")
      .run();
    await assert.rejects(() => database.prepare(`INSERT INTO edp_review_items (
      user_id, job_id, rule_id, template_row, automatic_status, final_status,
      evidence_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("shared-review-workspace", "job-1", "chemical_sds", 5, "maybe", "needs_human", "[]", "2026-08-01T00:02:00.000Z", "2026-08-01T00:02:00.000Z")
      .run());
  } finally {
    await miniflare.dispose();
  }
});

test("0016 EDP annual rule migration preserves reviews and constrains rule evidence", async () => {
  const [reviewMigration, annualRuleMigration, schema, journalSource] = await Promise.all([
    readFile(new URL("../drizzle/0015_edp_reviews.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0016_edp_annual_rules.sql", import.meta.url), "utf8").catch(() => ""),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
  assert.match(annualRuleMigration, /CREATE TABLE `edp_rule_documents`/u);
  assert.match(annualRuleMigration, /CREATE TABLE `edp_rule_facts`/u);
  assert.match(annualRuleMigration, /ADD `active_rule_document_id` text/u);
  assert.match(annualRuleMigration, /ADD `active_rule_version` text/u);
  assert.match(annualRuleMigration, /ADD `is_blocking` integer DEFAULT 1 NOT NULL/u);
  assert.match(annualRuleMigration, /ADD `rule_source` text DEFAULT 'builtin:v1' NOT NULL/u);
  assert.match(schema, /export const edpRuleDocuments/u);
  assert.match(schema, /export const edpRuleFacts/u);
  assert.match(schema, /activeRuleDocumentId: text\("active_rule_document_id"\)/u);
  assert.match(schema, /isBlocking: integer\("is_blocking"/u);
  assert.ok(JSON.parse(journalSource).entries.some((entry) => entry.tag === "0016_edp_annual_rules"));

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "edp-annual-rule-migration-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const statement of reviewMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    await database.prepare(`INSERT INTO edp_review_settings (
      user_id, competition_year, template_version, updated_at
    ) VALUES (?, ?, ?, ?)`)
      .bind("shared-review-workspace", "2026", "v1", "2026-09-02T00:00:00.000Z")
      .run();
    await database.prepare(`INSERT INTO edp_review_jobs (
      user_id, job_id, school_key, school_name, submission_id, submitted_at,
      submission_round, rule_version, template_version, status, overall_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("shared-review-workspace", "job-before-rules", "tianjin", "天津大学", "100", "2026-08-01T00:00:00.000Z", 1, "v1", "v1", "ready", "passed", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z")
      .run();
    await database.prepare(`INSERT INTO edp_review_items (
      user_id, job_id, rule_id, template_row, automatic_status, final_status,
      evidence_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("shared-review-workspace", "job-before-rules", "vehicle_photo", 11, "needs_human", "needs_human", "[]", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z")
      .run();

    for (const statement of annualRuleMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }

    const preservedSettings = await database.prepare(`SELECT active_rule_document_id, active_rule_version
      FROM edp_review_settings WHERE user_id = ?`).bind("shared-review-workspace").first();
    assert.deepEqual(preservedSettings, { active_rule_document_id: null, active_rule_version: null });
    const preservedItem = await database.prepare(`SELECT is_blocking, rule_source FROM edp_review_items
      WHERE user_id = ? AND job_id = ? AND rule_id = ?`)
      .bind("shared-review-workspace", "job-before-rules", "vehicle_photo").first();
    assert.deepEqual(preservedItem, { is_blocking: 1, rule_source: "builtin:v1" });

    const insertDocument = `INSERT INTO edp_rule_documents (
      user_id, document_id, applicable_year, entered_year, detected_year, filename,
      r2_key, sha256, size, status, parse_warnings_json, builtin_rule_version,
      rule_version, year_conflict_confirmed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await database.prepare(insertDocument).bind(
      "shared-review-workspace", "rules-2026-a", 2026, 2026, 2026, "2026规则.pdf",
      "edp-rules/2026/a.pdf", "a".repeat(64), 2048, "active", "[]", "v1",
      "2026-aaaaaaaaaaaa-v1", 0, "2026-09-02T01:00:00.000Z", "2026-09-02T01:00:00.000Z",
    ).run();
    await assert.rejects(() => database.prepare(insertDocument).bind(
      "shared-review-workspace", "rules-2026-b", 2026, 2026, 2026, "2026规则第二版.pdf",
      "edp-rules/2026/b.pdf", "b".repeat(64), 3072, "active", "[]", "v1",
      "2026-bbbbbbbbbbbb-v1", 0, "2026-09-02T02:00:00.000Z", "2026-09-02T02:00:00.000Z",
    ).run(), /UNIQUE/u);
    await assert.rejects(() => database.prepare(insertDocument).bind(
      "shared-review-workspace", "rules-invalid", 2026, 2026, 2026, "非法状态.pdf",
      "edp-rules/2026/invalid.pdf", "c".repeat(64), 1024, "published", "[]", "v1",
      "2026-cccccccccccc-v1", 0, "2026-09-02T03:00:00.000Z", "2026-09-02T03:00:00.000Z",
    ).run(), /CHECK/u);

    await database.prepare(`INSERT INTO edp_rule_facts (
      user_id, document_id, fact_id, category, section, normalized_requirement,
      operator, structured_value, structured_unit, condition_text, source_page,
      evidence_excerpt, confidence, confirmation_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        "shared-review-workspace", "rules-2026-a", "fact-pressure", "numeric_limit", "压力系统",
        "最大操作压力不得超过 500 psig", "lte", "500", "psig", null, 18,
        "最大操作压力不得超过 500 psig。", "high", "confirmed",
        "2026-09-02T01:00:00.000Z", "2026-09-02T01:00:00.000Z",
      ).run();
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_rule_facts").first()).total, 1);
    await assert.rejects(() => database.prepare(`UPDATE edp_review_items SET is_blocking = 2
      WHERE user_id = ? AND job_id = ? AND rule_id = ?`)
      .bind("shared-review-workspace", "job-before-rules", "vehicle_photo").run(), /CHECK/u);
  } finally {
    await miniflare.dispose();
  }
});

test("0017 EDP submission archive metadata migration preserves legacy rows and constrains values", async () => {
  const [edpMigration, metadataMigration, journalSource] = await Promise.all([
    readFile(new URL("../drizzle/0001_edp_collector.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0017_edp_submission_archive_metadata.sql", import.meta.url), "utf8").catch(() => ""),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
  assert.match(metadataMigration, /ADD `submission_round` integer/u);
  assert.ok(JSON.parse(journalSource).entries.some(({ tag }) => tag === "0017_edp_submission_archive_metadata"));

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "edp-archive-metadata-migration-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const statement of edpMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    await database.prepare(`INSERT INTO edp_submissions (
      user_id, school_key, school_name, r2_key, filename, content_type, submitted_at,
      submission_id, size, file_count, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("shared-browser-workspace", "天津大学", "天津大学", "edp/tianjin/current.zip", "天津大学-EDP.zip", "application/zip", "2026-08-01T00:00:00.000Z", "100", 1024, 3, "2026-08-01T00:01:00.000Z")
      .run();
    for (const statement of metadataMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
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
    await assert.rejects(() => database.prepare("UPDATE edp_submissions SET submission_round = 6").run(), /CHECK/u);
    await assert.rejects(() => database.prepare("UPDATE edp_submissions SET archive_format = 'exe'").run(), /CHECK/u);
    await assert.rejects(() => database.prepare("UPDATE edp_submissions SET embedded_registration_status = 'lost'").run(), /CHECK/u);
  } finally {
    await miniflare.dispose();
  }
});

test("0018 EDP review identity migration preserves jobs and adds extracted cover fields", async () => {
  const [reviewMigration, identityMigration, schema, journalSource] = await Promise.all([
    readFile(new URL("../drizzle/0015_edp_reviews.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0018_edp_review_extracted_identity.sql", import.meta.url), "utf8").catch(() => ""),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ]);
  assert.match(identityMigration, /ADD `work_name` text/u);
  assert.match(identityMigration, /ADD `instructor_name` text/u);
  assert.match(identityMigration, /ADD `instructor_email` text/u);
  assert.match(schema, /workName: text\("work_name"\)/u);
  assert.ok(JSON.parse(journalSource).entries.some((entry) => entry.tag === "0018_edp_review_extracted_identity"));

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "edp-review-identity-migration-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const statement of reviewMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    await database.prepare(`INSERT INTO edp_review_jobs (
      user_id, job_id, school_key, school_name, submission_id, submitted_at,
      submission_round, rule_version, template_version, status, overall_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("shared-review-workspace", "job-identity", "dalian", "大连理工大学", "200", "2026-09-08T00:00:00.000Z", 2, "v1", "v1", "queued", "pending", "2026-09-08T00:00:01.000Z", "2026-09-08T00:00:01.000Z")
      .run();
    for (const statement of identityMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    assert.deepEqual(await database.prepare(`SELECT school_name, work_name, instructor_name, instructor_email
      FROM edp_review_jobs WHERE job_id = ?`).bind("job-identity").first(), {
      school_name: "大连理工大学",
      work_name: null,
      instructor_name: null,
      instructor_email: null,
    });
  } finally {
    await miniflare.dispose();
  }
});

test("annual EDP rule parser validates PDFs and extracts traceable rule facts", async () => {
  const {
    MAX_EDP_RULE_PDF_BYTES,
    EdpRulePdfError,
    buildEdpRuleVersion,
    classifyPdfLoadFailure,
    extractEdpRuleFactCandidates,
    parseEdpRuleTextPages,
    validateEdpRulePdfEnvelope,
  } = await loadEdpRuleParser();

  assert.equal(MAX_EDP_RULE_PDF_BYTES, 50 * 1024 * 1024);
  assert.throws(
    () => validateEdpRulePdfEnvelope(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 4),
    (error) => error instanceof EdpRulePdfError && error.code === "invalid_pdf_header",
  );
  assert.throws(
    () => validateEdpRulePdfEnvelope(new TextEncoder().encode("%PDF-1.7"), MAX_EDP_RULE_PDF_BYTES + 1),
    (error) => error instanceof EdpRulePdfError && error.code === "rule_pdf_too_large",
  );
  assert.equal(classifyPdfLoadFailure(new Error("No password given")), "encrypted_pdf");
  assert.equal(classifyPdfLoadFailure(new Error("Invalid PDF structure")), "invalid_pdf");

  const sha256 = "0123456789abcdef".repeat(4);
  assert.equal(buildEdpRuleVersion(2026, sha256, "v1"), "2026-0123456789abcdef-v1");
  assert.equal(buildEdpRuleVersion(2026, sha256, "v1"), buildEdpRuleVersion(2026, sha256, "v1"));
  assert.notEqual(buildEdpRuleVersion(2026, `f${sha256.slice(1)}`, "v1"), buildEdpRuleVersion(2026, sha256, "v1"));

  const pages = [
    "附件3 2026中国大学生Chem-E-Car竞赛规则。第一章 安全要求。承压设备最大操作压力不得超过 500 psig。禁止使用含铅电池。",
    "第二章 提交要求。每支队伍必须提交 3 份 EDP 文件。仅当系统压力高于 5 psig 时，必须提供压力计算与泄压装置。",
    "附录列出2025年竞赛实例，仅用于说明历年方案。",
  ];
  const result = await parseEdpRuleTextPages({ pages, enteredYear: 2026, sha256, builtinRuleVersion: "v1" });
  assert.equal(result.detectedYear, 2026);
  assert.equal(result.yearConflict, false);
  assert.equal(result.version, "2026-0123456789abcdef-v1");
  assert.ok(result.warnings.some((warning) => /2025/u.test(warning)), "secondary years must be disclosed without replacing the detected rule year");
  assert.ok(result.facts.length >= 4);

  const pressure = result.facts.find(({ normalizedRequirement }) => /500 psig/iu.test(normalizedRequirement));
  assert.deepEqual(
    {
      category: pressure.category,
      operator: pressure.operator,
      value: pressure.value,
      unit: pressure.unit,
      page: pressure.page,
      confidence: pressure.confidence,
    },
    { category: "numeric_limit", operator: "lte", value: "500", unit: "psig", page: 1, confidence: "high" },
  );
  assert.match(pressure.excerpt, /最大操作压力/u);
  assert.ok(pressure.excerpt.length <= 240);

  const prohibited = result.facts.find(({ category }) => category === "prohibited");
  assert.equal(prohibited.operator, "must_not");
  assert.equal(prohibited.page, 1);
  assert.match(prohibited.normalizedRequirement, /含铅电池/u);

  const conditional = result.facts.find(({ category }) => category === "conditional");
  assert.equal(conditional.operator, "conditional");
  assert.equal(conditional.page, 2);
  assert.match(conditional.condition, /压力高于 5 psig/u);

  const duplicateRun = await extractEdpRuleFactCandidates(pages);
  assert.deepEqual(
    duplicateRun.map(({ factId }) => factId),
    result.facts.map(({ factId }) => factId),
    "fact IDs must be stable for the same pages",
  );

  const conflict = await parseEdpRuleTextPages({ pages, enteredYear: 2025, sha256, builtinRuleVersion: "v1" });
  assert.equal(conflict.detectedYear, 2026);
  assert.equal(conflict.yearConflict, true);
  assert.ok(conflict.warnings.some((warning) => /填写年份 2025.*检测年份 2026/u.test(warning)));

  await assert.rejects(
    () => parseEdpRuleTextPages({ pages: [" ", "\n"], enteredYear: 2026, sha256, builtinRuleVersion: "v1" }),
    (error) => error instanceof EdpRulePdfError && error.code === "rule_pdf_has_no_text",
  );
});

test("annual EDP rule document API preserves candidates and activates one version per year", async () => {
  const migrationFiles = [
    "0002_app_password_auth.sql",
    "0005_founder_shared_password.sql",
    "0015_edp_reviews.sql",
    "0016_edp_annual_rules.sql",
  ];
  const migrations = await Promise.all(
    migrationFiles.map((filename) => readFile(new URL(`../drizzle/${filename}`, import.meta.url), "utf8")),
  );
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-15",
    d1Databases: { DB: "edp-rule-document-api-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const migration of migrations) {
      for (const statement of migration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
    }
    const files = new FakeR2();
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const [worker, cookie] = await Promise.all([loadWorker(), authenticatedCookie()]);

    const anonymous = await callApi(worker, env, "/api/edp-rule-documents");
    assert.equal(anonymous.status, 401);

    const uploadRule = async (year, filename, bytes) => {
      const form = new FormData();
      form.set("year", String(year));
      form.set("file", new Blob([bytes], { type: "application/pdf" }), filename);
      const response = await callApi(worker, env, "/api/edp-rule-documents", {
        method: "POST",
        origin: AUTH_ORIGIN,
        cookie,
        body: form,
      });
      return { response, payload: await response.json() };
    };
    const activateRule = async (documentId, body = {}) => {
      const response = await callApi(worker, env, `/api/edp-rule-documents/${encodeURIComponent(documentId)}/activate`, {
        method: "POST",
        origin: AUTH_ORIGIN,
        cookie,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { response, payload: await response.json() };
    };

    const firstBytes = simpleTextPdfBytes("2026 Chem-E-Car Competition Rules. Annual safety requirements.");
    const first = await uploadRule(2026, "2026竞赛规则.pdf", firstBytes);
    assert.equal(first.response.status, 201, JSON.stringify(first.payload));
    assert.equal(first.payload.document.status, "needs_confirmation");
    assert.equal(first.payload.document.applicableYear, 2026);
    assert.equal(first.payload.document.detectedYear, 2026);
    assert.equal(first.payload.document.yearConflict, false);
    assert.match(first.payload.document.ruleVersion, /^2026-[a-f0-9]{16}-v1$/u);
    assert.equal(files.putCalls.length, 1);

    const duplicate = await uploadRule(2026, "同内容重复上传.pdf", firstBytes);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.payload.duplicate, true);
    assert.equal(duplicate.payload.document.documentId, first.payload.document.documentId);
    assert.equal(files.putCalls.length, 1, "the same annual PDF must not be stored twice");

    const listBeforeActivation = await callApi(worker, env, "/api/edp-rule-documents", { cookie });
    assert.equal(listBeforeActivation.status, 200);
    const listedBeforeActivation = await listBeforeActivation.json();
    assert.equal(listedBeforeActivation.documents.length, 1);
    assert.deepEqual(listedBeforeActivation.activeByYear, {});

    const firstDetail = await callApi(worker, env, `/api/edp-rule-documents/${first.payload.document.documentId}`, { cookie });
    assert.equal(firstDetail.status, 200);
    const firstDetailPayload = await firstDetail.json();
    assert.ok(Array.isArray(firstDetailPayload.facts));
    assert.deepEqual(Object.keys(firstDetailPayload.changes).sort(), ["added", "changed", "removed"]);

    const firstActivation = await activateRule(first.payload.document.documentId);
    assert.equal(firstActivation.response.status, 200);
    assert.equal(firstActivation.payload.document.status, "active");

    const conflictBytes = simpleTextPdfBytes("2026 Chem-E-Car Competition Rules. Year conflict fixture.");
    const conflict = await uploadRule(2025, "操作者选择2025.pdf", conflictBytes);
    assert.equal(conflict.response.status, 201);
    assert.equal(conflict.payload.document.yearConflict, true);
    const blockedConflict = await activateRule(conflict.payload.document.documentId);
    assert.equal(blockedConflict.response.status, 409);
    assert.equal(blockedConflict.payload.error.code, "rule_year_conflict_confirmation_required");
    const confirmedConflict = await activateRule(conflict.payload.document.documentId, { confirmYearConflict: true });
    assert.equal(confirmedConflict.response.status, 200);
    assert.equal(confirmedConflict.payload.document.status, "active");

    const secondBytes = simpleTextPdfBytes("2026 Chem-E-Car Competition Rules. Annual safety requirements revision two.");
    const second = await uploadRule(2026, "2026竞赛规则第二版.pdf", secondBytes);
    assert.equal(second.response.status, 201);
    const secondActivation = await activateRule(second.payload.document.documentId);
    assert.equal(secondActivation.response.status, 200);
    const versionRows = await database.prepare(`SELECT document_id, status FROM edp_rule_documents
      WHERE user_id = ? AND applicable_year = 2026 ORDER BY created_at`).bind("shared-browser-workspace").all();
    assert.deepEqual(
      versionRows.results.map(({ document_id, status }) => [document_id, status]),
      [
        [first.payload.document.documentId, "archived"],
        [second.payload.document.documentId, "active"],
      ],
    );

    const download = await callApi(
      worker,
      env,
      `/api/edp-rule-documents/${second.payload.document.documentId}/download`,
      { cookie },
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("Content-Type"), "application/pdf");
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), secondBytes);

    const activeDelete = await callApi(worker, env, `/api/edp-rule-documents/${second.payload.document.documentId}`, {
      method: "DELETE",
      origin: AUTH_ORIGIN,
      cookie,
    });
    assert.equal(activeDelete.status, 409);
    assert.equal((await activeDelete.json()).error.code, "active_rule_cannot_be_deleted");

    const deletable = await uploadRule(2027, "2027候选规则.pdf", simpleTextPdfBytes("2027 Chem-E-Car Competition Rules. Candidate."));
    const deletableKey = deletable.payload.document.r2Key;
    assert.ok(files.objects.has(deletableKey));
    const deleted = await callApi(worker, env, `/api/edp-rule-documents/${deletable.payload.document.documentId}`, {
      method: "DELETE",
      origin: AUTH_ORIGIN,
      cookie,
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, true);
    assert.equal(files.objects.has(deletableKey), false);

    const referenced = await uploadRule(2028, "2028候选规则.pdf", simpleTextPdfBytes("2028 Chem-E-Car Competition Rules. Candidate."));
    await database.prepare(`INSERT INTO edp_review_jobs (
      user_id, job_id, school_key, school_name, submission_id, submitted_at,
      submission_round, rule_version, template_version, status, overall_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        "shared-browser-workspace", "referenced-rule-job", "tianjin", "天津大学", "submission-2028",
        "2028-01-01T00:00:00.000Z", 1, referenced.payload.document.ruleVersion, "v1", "queued", "pending",
        "2028-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z",
      ).run();
    const referencedDelete = await callApi(worker, env, `/api/edp-rule-documents/${referenced.payload.document.documentId}`, {
      method: "DELETE",
      origin: AUTH_ORIGIN,
      cookie,
    });
    assert.equal(referencedDelete.status, 409);
    assert.equal((await referencedDelete.json()).error.code, "referenced_rule_cannot_be_deleted");

    const broken = await uploadRule(2029, "损坏规则.pdf", new TextEncoder().encode("%PDF-1.7\nthis is not a real PDF"));
    assert.equal(broken.response.status, 422);
    assert.equal(broken.payload.error.code, "invalid_pdf");
    assert.equal(broken.payload.document.status, "failed");
    const active2026 = await database.prepare(`SELECT document_id FROM edp_rule_documents
      WHERE user_id = ? AND applicable_year = 2026 AND status = 'active'`)
      .bind("shared-browser-workspace").first();
    assert.equal(active2026.document_id, second.payload.document.documentId, "a failed upload must not replace the active version");
  } finally {
    await miniflare.dispose();
  }
});

test("EDP locked rule lifecycle and recipient boundary", async () => {
  const [worker, cookie] = await Promise.all([loadWorker(), authenticatedCookie()]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-15",
    d1Databases: { DB: "edp-locked-rule-lifecycle-test" },
  });
  const files = new FakeR2();
  try {
    const database = await miniflare.getD1Database("DB");
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const reviewSettings = await callApi(worker, env, "/api/edp-reviews/settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        competitionYear: "2026",
        safetyReviewerName: "",
        safetyReviewerEmail: "",
        expertMemberName: "",
        expertMemberEmail: "",
      }),
    });
    assert.equal(reviewSettings.status, 200);
    const receiptSettings = await callApi(worker, env, "/api/edp-receipt-settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitionYear: "2026", submissionRound: 1 }),
    });
    assert.equal(receiptSettings.status, 200);

    const registrationForm = new FormData();
    registrationForm.set("file", new File(
      [registrationWorkbookBytes("华东理工大学", "Mag-ECUSTic Velocity")],
      "华东理工大学-报名表.xlsx",
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    ));
    const registration = await callApi(worker, env, "/api/registrations", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: registrationForm,
    });
    assert.equal(registration.status, 201, await registration.text());

    const uploadAndActivateRule = async (description) => {
      const form = new FormData();
      form.set("year", "2026");
      form.set("file", new Blob([
        simpleTextPdfBytes(`2026 Chem-E-Car Competition Rules. ${description}`),
      ], { type: "application/pdf" }), "2026竞赛规则.pdf");
      const upload = await callApi(worker, env, "/api/edp-rule-documents", {
        method: "POST", origin: AUTH_ORIGIN, cookie, body: form,
      });
      const uploaded = await upload.json();
      assert.equal(upload.status, 201, JSON.stringify(uploaded));
      const activation = await callApi(worker, env, `/api/edp-rule-documents/${uploaded.document.documentId}/activate`, {
        method: "POST",
        origin: AUTH_ORIGIN,
        cookie,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(activation.status, 200, await activation.text());
      const pressureLimit = description.match(/(\d+)\s*psig/iu)?.[1] ?? "500";
      await database.prepare(`INSERT OR REPLACE INTO edp_rule_facts (
        user_id, document_id, fact_id, category, section, normalized_requirement,
        operator, structured_value, structured_unit, condition_text, source_page,
        evidence_excerpt, confidence, confirmation_status, created_at, updated_at
      ) VALUES (?, ?, ?, 'numeric_limit', 'Pressure', ?, 'lte', ?, 'psig', NULL, 1, ?, 'high', 'confirmed', ?, ?)`)
        .bind(
          "shared-browser-workspace",
          uploaded.document.documentId,
          `mop-${pressureLimit}`,
          `Maximum operating pressure MOP must not exceed ${pressureLimit} psig.`,
          pressureLimit,
          description,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ).run();
      return uploaded.document;
    };

    const firstRule = await uploadAndActivateRule("Maximum operating pressure MOP must not exceed 500 psig.");
    const edpForm = new FormData();
    edpForm.set("file", await makeEdpZip());
    edpForm.set("schoolName", "华东理工大学");
    edpForm.set("submittedAt", "2026-08-20T08:00:00.000Z");
    edpForm.set("submissionId", "locked-rule-source");
    const submission = await callApi(worker, env, "/api/edp-submissions", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: edpForm,
    });
    const submissionPayload = await submission.json();
    assert.equal(submission.status, 201, JSON.stringify(submissionPayload));
    assert.equal(submissionPayload.submission.receipt.recipientEmail, "team@example.edu.cn", "only the registration receipt email may be used");
    assert.equal(submissionPayload.reviewJob.ruleVersion, firstRule.ruleVersion);

    const secondRule = await uploadAndActivateRule("Maximum operating pressure MOP must not exceed 450 psig.");
    assert.notEqual(firstRule.ruleVersion, secondRule.ruleVersion);

    const firstJobId = submissionPayload.reviewJob.jobId;
    const runLocked = await callApi(worker, env, `/api/edp-reviews/${firstJobId}/run`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    const lockedPayload = await runLocked.json();
    assert.equal(runLocked.status, 200, JSON.stringify(lockedPayload));
    assert.equal(lockedPayload.job.ruleVersion, firstRule.ruleVersion, "running an old job must keep its original annual rule version");
    assert.ok(lockedPayload.items.some(({ ruleSource }) => ruleSource.startsWith(`annual:${firstRule.ruleVersion}:`)));
    const coverRegistration = lockedPayload.items.find(({ ruleId }) => ruleId === "cover_registration_consistency");
    assert.doesNotMatch(coverRegistration.suggestedComment, /未取得对应报名表/u, "the latest stored registration must be supplied to the cover audit");

    const recheck = await callApi(worker, env, `/api/edp-reviews/${firstJobId}/recheck-latest`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    const recheckPayload = await recheck.json();
    assert.equal(recheck.status, 201, JSON.stringify(recheckPayload));
    assert.notEqual(recheckPayload.job.jobId, firstJobId);
    assert.equal(recheckPayload.job.ruleVersion, secondRule.ruleVersion);
    assert.equal(recheckPayload.previousJob.jobId, firstJobId);
    assert.equal(recheckPayload.previousJob.ruleVersion, firstRule.ruleVersion);
    assert.equal(recheckPayload.previousJob.supersededBy, recheckPayload.job.jobId);

    const rerunOriginal = await callApi(worker, env, `/api/edp-reviews/${firstJobId}/run`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(rerunOriginal.status, 200, "creating a latest-rule recheck must not disable the historical job");
    assert.equal((await rerunOriginal.json()).job.ruleVersion, firstRule.ruleVersion);
  } finally {
    await miniflare.dispose();
  }
});

test("EDP strict review rules keep missing, conflicting, and unreadable evidence for human confirmation", async () => {
  const {
    EDP_REVIEW_RULE_ROWS,
    EDP_REVIEW_RULES,
    resolveEdpReviewRule,
  } = await loadEdpReviewRules();
  const expectedRows = {
    chemical_sds: 5,
    ppe: 6,
    reactions_overview: 8,
    onsite_hydrogen: 9,
    operating_principle: 10,
    vehicle_photo: 11,
    syringes_fixed: 12,
    secondary_containment: 13,
    component_specs: 15,
    commercial_component_docs: 16,
    pressure_vessel_certificate: 18,
    no_plastic_pressure: 19,
    mawp_gt_mop: 20,
    plastic_pressure_test_docs: 21,
    pressure_relief_device: 22,
    unknown_mawp_external_cert: 23,
    instructor_signed_relief_basis: 24,
    relief_sizing: 25,
    relief_test: 26,
    max_pressure_500psig: 27,
    hazard_types: 29,
    jsa: 30,
    safeguards: 31,
    rule_violations: 32,
    moc: 34,
    aisle: 36,
    emergency_equipment: 37,
    sop: 39,
    chemical_waste_sop: 40,
    post_competition_cleanup: 41,
    certification_signatures: 43,
    ten_hours_experience: 44,
  };
  assert.deepEqual({ ...EDP_REVIEW_RULE_ROWS }, expectedRows);
  assert.equal(EDP_REVIEW_RULES.length, 32);
  assert.deepEqual(EDP_REVIEW_RULES.map(({ id, row }) => [id, row]), Object.entries(expectedRows));

  const rule = (id) => EDP_REVIEW_RULES.find((entry) => entry.id === id);
  const document = (text, textQuality = "usable", role = "chinese_edp") => ({
    role,
    filename: `${role}.pdf`,
    pages: [text],
    textQuality,
  });

  const positive = resolveEdpReviewRule(rule("chemical_sds"), [
    document("本项目所涉及的全部反应物和产物均附有安全数据表 SDS，且不使用含铅电池。"),
  ]);
  assert.equal(positive.status, "yes");
  assert.equal(positive.evidence[0].page, 1);
  assert.match(positive.evidence[0].excerpt, /安全数据表/u);

  const notApplicable = resolveEdpReviewRule(rule("pressure_relief_device"), [
    document("本车无压力系统，因此压力释放装置不适用。"),
  ]);
  assert.equal(notApplicable.status, "not_applicable");

  const missing = resolveEdpReviewRule(rule("chemical_sds"), [document("车辆设计说明。")]);
  assert.equal(missing.status, "needs_human", "keyword absence must never be treated as a failed review");
  assert.equal(missing.evidence.length, 0);

  const conflict = resolveEdpReviewRule(rule("max_pressure_500psig"), [
    document("最大操作压力为 450 psig，不超过 500 psig。"),
    document("最大操作压力为 600 psig，超过 500 psig。", "usable", "supplement"),
  ]);
  assert.equal(conflict.status, "needs_human");
  assert.ok(conflict.evidence.length >= 2);

  const explicitFailure = resolveEdpReviewRule(rule("max_pressure_500psig"), [
    document("最大操作压力为 600 psig，超过 500 psig。"),
  ]);
  assert.equal(explicitFailure.status, "no");

  const unreadable = resolveEdpReviewRule(rule("chemical_sds"), [
    document("本项目所涉及的全部反应物和产物均附有 SDS。", "low"),
  ]);
  assert.equal(unreadable.status, "needs_human");
});

test("EDP blocking review semantics defer photos and apply only confirmed objective annual facts", async () => {
  const { EDP_REVIEW_RULES, resolveEdpReviewRule } = await loadEdpReviewRules();
  const { computeOverallReviewStatus, resolveAnnualRuleFact } = await loadEdpReviewEngine();
  const document = (text, role = "chinese_edp") => ({
    role,
    filename: `${role}.pdf`,
    pages: [text],
    textQuality: "usable",
  });
  const vehiclePhoto = EDP_REVIEW_RULES.find(({ id }) => id === "vehicle_photo");
  const pressure = EDP_REVIEW_RULES.find(({ id }) => id === "max_pressure_500psig");
  assert.equal(vehiclePhoto.isBlocking, false);
  assert.equal(pressure.isBlocking, true);
  const deferredPhoto = resolveEdpReviewRule(vehiclePhoto, [document("整车图片位于本页。")]);
  assert.equal(deferredPhoto.status, "needs_human");
  assert.equal(deferredPhoto.isBlocking, false);
  assert.equal(deferredPhoto.ruleSource, "builtin:v1");
  assert.match(deferredPhoto.suggestedComment, /暂缓审核.*不阻塞/u);
  const builtinPressure = resolveEdpReviewRule(pressure, [document("最大操作压力不超过 500 psig。")]);
  assert.equal(builtinPressure.isBlocking, true);
  assert.equal(builtinPressure.ruleSource, "builtin:v1");

  assert.equal(computeOverallReviewStatus([
    { status: "yes", isBlocking: true },
    { status: "needs_human", isBlocking: false },
  ]), "passed");
  assert.equal(computeOverallReviewStatus([
    { status: "yes", isBlocking: true },
    { status: "needs_human", isBlocking: true },
  ]), "needs_human");
  assert.equal(computeOverallReviewStatus([
    { status: "no", isBlocking: false },
  ]), "failed", "an explicit failure remains a failure even when a deferred item would not block human resolution");

  const annualFact = {
    factId: "fact-mop",
    category: "numeric_limit",
    normalizedRequirement: "最大操作压力不得超过 500 psig",
    operator: "lte",
    value: "500",
    unit: "psig",
    page: 18,
    excerpt: "最大操作压力不得超过 500 psig。",
    confidence: "high",
    confirmationStatus: "confirmed",
  };
  const annualFailure = resolveAnnualRuleFact(
    annualFact,
    [document("系统的最大操作压力 MOP 为 600 psig。")],
    "2026-abcdef-v1",
  );
  assert.equal(annualFailure.status, "no");
  assert.equal(annualFailure.isBlocking, true);
  assert.equal(annualFailure.ruleSource, "annual:2026-abcdef-v1:fact-mop");
  assert.equal(annualFailure.evidence[0].page, 1);
  const annualPass = resolveAnnualRuleFact(
    annualFact,
    [document("系统最大操作压力为 450 psig。")],
    "2026-abcdef-v1",
  );
  assert.equal(annualPass.status, "yes");

  for (const uncertainFact of [
    { ...annualFact, confirmationStatus: "pending" },
    { ...annualFact, confidence: "low" },
    {
      ...annualFact,
      category: "required",
      operator: "must",
      value: null,
      unit: null,
      normalizedRequirement: "参赛队必须遵守安全要求",
    },
  ]) {
    const uncertain = resolveAnnualRuleFact(uncertainFact, [document("系统最大操作压力为 450 psig。")], "2026-abcdef-v1");
    assert.equal(uncertain.status, "needs_human");
    assert.equal(uncertain.isBlocking, true);
  }
});

test("EDP cover and bilingual audit checks eight fields while ignoring three onsite placeholders", async () => {
  const {
    auditBilingualObjectiveConsistency,
    auditEdpCover,
    extractEdpCoverFields,
  } = await loadEdpDetailedAudit();
  const document = (role, pages) => ({ role, filename: `${role}.pdf`, pages, textQuality: "usable" });
  const chineseCover = [
    "学校名称：天津大学 | 队长姓名：张三 | 指导教师姓名：李教授 | 队名：津能一号 | 队长邮箱：captain@example.invalid | 指导教师邮箱：advisor@example.invalid | Revision：2 | Revision Date：2026-05-01 | OnsiteSafetyJudge： | OnsiteTrackLength： | OnsiteTrackWidth：",
    "动力来源：Zn + 2HCl → ZnCl2 + H2，系统压力 20 kPa。控制机制：I2 + 2S2O3 → 2I + S4O6，反应 15 s 后停止。辅助过程：不适用。",
  ];
  const englishCover = [
    "School Name: Tianjin University | Captain Name: Zhang San | Faculty Advisor Name: Professor Li | Team Name: Jinneng One | Captain Email: captain@example.invalid | Faculty Advisor Email: advisor@example.invalid | Revision: 2 | Revision Date: 2026-05-01 | OnsiteSafetyJudge: | OnsiteTrackLength: | OnsiteTrackWidth:",
    "Power source: Zn + 2HCl → ZnCl2 + H2, system pressure 20 kPa. Control mechanism: I2 + 2S2O3 → 2I + S4O6, stops after 15 s. Auxiliary process: N/A.",
  ];
  const documents = [document("chinese_edp", chineseCover), document("english_edp", englishCover)];
  const extracted = extractEdpCoverFields(documents[0]);
  assert.deepEqual(extracted, {
    schoolName: "天津大学",
    captainName: "张三",
    supervisorName: "李教授",
    teamName: "津能一号",
    captainEmail: "captain@example.invalid",
    supervisorEmail: "advisor@example.invalid",
    revision: "2",
    revisionDate: "2026-05-01",
  });

  const cover = auditEdpCover(documents, {
    schoolName: "天津大学",
    captainName: "张三",
    teamName: "津能一号",
  });
  const coverById = new Map(cover.map((item) => [item.ruleId, item]));
  assert.equal(coverById.get("cover_required_fields").status, "yes");
  assert.equal(coverById.get("cover_bilingual_consistency").status, "needs_human", "translated names require human confirmation");
  assert.equal(coverById.get("cover_registration_consistency").status, "yes");
  assert.ok(cover.every(({ suggestedComment }) => !/OnsiteSafetyJudge|OnsiteTrackLength|OnsiteTrackWidth/u.test(suggestedComment)));

  const missingEmailDocuments = [
    document("chinese_edp", [chineseCover[0].replace("队长邮箱：captain@example.invalid | ", ""), chineseCover[1]]),
    documents[1],
  ];
  const missing = auditEdpCover(missingEmailDocuments, null);
  const missingRequired = missing.find(({ ruleId }) => ruleId === "cover_required_fields");
  assert.equal(missingRequired.status, "no");
  assert.match(missingRequired.suggestedComment, /队长邮箱/u);
  assert.doesNotMatch(missingRequired.suggestedComment, /Onsite/u);

  const revisionMismatch = auditEdpCover([
    documents[0],
    document("english_edp", [englishCover[0].replace("Revision: 2", "Revision: 3"), englishCover[1]]),
  ], null).find(({ ruleId }) => ruleId === "cover_bilingual_consistency");
  assert.equal(revisionMismatch.status, "no");
  assert.match(revisionMismatch.suggestedComment, /Revision/u);

  const objectiveMatch = auditBilingualObjectiveConsistency(documents);
  assert.equal(objectiveMatch.status, "yes");
  const objectiveMismatch = auditBilingualObjectiveConsistency([
    documents[0],
    document("english_edp", [englishCover[0], englishCover[1].replace("20 kPa", "25 kPa")]),
  ]);
  assert.equal(objectiveMismatch.status, "no");
  assert.match(objectiveMismatch.suggestedComment, /数值/u);
  const narrativeOnly = auditBilingualObjectiveConsistency([
    document("chinese_edp", [chineseCover[0], "采用化学反应推进并自动停止。"]),
    document("english_edp", [englishCover[0], "A chemical reaction propels and stops the vehicle."]),
  ]);
  assert.equal(narrativeOnly.status, "needs_human");
});

test("EDP cover extraction understands the flattened labels used by the Dalian template", async () => {
  const {
    auditEdpCover,
    extractEdpCoverFields,
    extractEdpWorkbookIdentity,
  } = await loadEdpDetailedAudit();
  const chinese = {
    role: "chinese_edp",
    filename: "大连理工大学-EDP.pdf",
    pages: [
      "更新于 2026 年 5 月 1 2026 工程文件包 (EDP) University : 大连理工大学 Vehicle Name: 示例小车 Team Captain Name : 示例队长 Team Captain Email: captain@example.invalid Faculty Supervisor: 示例教师甲，示例教师乙 Supervisor Email: teacher.one@example.invalid teacher.two@example.invalid Revision # : 2 Revision Date : 2026.5.23 OnsiteSafetyJudge:",
    ],
    textQuality: "usable",
  };
  const fields = extractEdpCoverFields(chinese);
  assert.deepEqual(fields, {
    schoolName: "大连理工大学",
    captainName: "示例队长",
    supervisorName: "示例教师甲,示例教师乙",
    teamName: "示例小车",
    captainEmail: "captain@example.invalid",
    supervisorEmail: "teacher.one@example.invalid teacher.two@example.invalid",
    revision: "2",
    revisionDate: "2026.5.23",
  });
  assert.deepEqual(extractEdpWorkbookIdentity([chinese]), {
    workName: "示例小车",
    instructorName: "示例教师甲,示例教师乙",
    instructorEmail: "teacher.one@example.invalid teacher.two@example.invalid",
  });
  const required = auditEdpCover([
    chinese,
    { ...chinese, role: "english_edp", filename: "Dalian-EDP-English.pdf" },
  ], null).find(({ ruleId }) => ruleId === "cover_required_fields");
  assert.equal(required.status, "yes", required.suggestedComment);
});

test("EDP detailed safety SOP and history audit distinguishes complete evidence from vague text", async () => {
  const { auditDetailedEdpDocuments } = await loadEdpDetailedAudit();
  const document = (pages) => ({ role: "chinese_edp", filename: "中文版EDP.pdf", pages, textQuality: "usable" });
  const complete = document([
    "学校名称：天津大学。",
    [
      "动力来源：Zn + 2HCl → ZnCl2 + H2，氢气推动活塞并驱动车轮；反应在25 ℃、1 mol/L条件下进行。",
      "控制机制：I2 + 2S2O3 → 2I + S4O6，颜色变化触发制动并停止小车。",
      "辅助过程：不适用。",
      "潜在风险：盐酸腐蚀、氢气泄漏和压力升高。预防和减轻措施：佩戴护目镜和耐酸手套，使用密闭容器并安装泄压阀。",
      "创新点：采用双传感器闭环控制降低停止距离误差，并改进动力气体缓释结构。",
      "比赛现场电源插座：不适用。",
    ].join("\n"),
    [
      "标准安全操作程序：步骤顺序 | 潜在危险 | 控制风险的步骤 | 所需个人防护用品或设备。",
      "紧急停止：1.关闭反应阀；2.断开反应器。",
      "开始/准备：称取5.0 g锌，量取20 mL、1 mol/L盐酸，在25 ℃下混合30 s，佩戴护目镜和耐酸手套。",
      "行驶过程：观察压力表并保持人员在安全线外。停止过程：关闭阀门并拆除驱动连接。",
      "行驶距离调整过程：每次将盐酸体积调整1 mL并重新记录。",
      "清洁和赛后处置：冲洗器材并收集全部废液。",
      "废物处理：酸性含锌废液装入耐酸带盖容器，标注成分和腐蚀危险，不得与碱性废液混合，赛后交学校危废中心处理。",
    ].join("\n"),
    "近五年方案：2025：无。2024：动力来源为过氧化氢分解；控制机制为碘钟；反应方程式为2H2O2 → 2H2O + O2。2023：无。",
  ]);
  const completeItems = new Map(auditDetailedEdpDocuments([complete], {
    prohibitRecentReactionReuse: true,
  }).map((item) => [item.ruleId, item]));
  for (const id of [
    "power_equation_logic",
    "control_equation_logic",
    "risks_and_mitigations",
    "innovation_statement",
    "sop_stages",
    "sop_four_columns",
    "sop_quantification",
    "waste_handling_detail",
    "previous_five_years",
  ]) assert.equal(completeItems.get(id).status, "yes", id);
  assert.equal(completeItems.get("auxiliary_process").status, "not_applicable");
  assert.equal(completeItems.get("outlet_requirement").status, "not_applicable");

  const vague = document([
    "学校名称：测试大学。",
    [
      "动力来源：采用电池驱动。控制机制：利用颜色变化停止。",
      "辅助过程：进行电池充电。潜在风险：无风险。预防措施：注意安全。",
      "创新点：待填写。比赛现场电源插座：需要电源。",
    ].join("\n"),
    [
      "标准安全操作程序。紧急停止：1.关阀；2.断电；3.拆卸装置。",
      "开始/准备：加入适量反应物并按需搅拌。行驶过程：观察。停止过程：停止。清洁：妥善处理废物。",
    ].join("\n"),
    "近五年方案：2025：动力来源为锌和盐酸；控制机制为碘钟；反应方程式为Zn + 2HCl → ZnCl2 + H2。",
  ]);
  const vagueItems = new Map(auditDetailedEdpDocuments([vague], {
    prohibitRecentReactionReuse: true,
    currentPowerEquation: "Zn + 2HCl → ZnCl2 + H2",
  }).map((item) => [item.ruleId, item]));
  for (const id of [
    "power_equation_logic",
    "control_equation_logic",
    "auxiliary_process",
    "risks_and_mitigations",
    "innovation_statement",
    "outlet_requirement",
    "sop_stages",
    "sop_four_columns",
    "sop_quantification",
    "waste_handling_detail",
    "previous_five_years",
  ]) assert.equal(vagueItems.get(id).status, "no", id);
  assert.match(vagueItems.get("sop_quantification").suggestedComment, /适量|定量/u);
  assert.match(vagueItems.get("previous_five_years").suggestedComment, /2025.*相同/u);
});

test("EDP mixed evidence excludes English-only chapters from Chinese bilingual completeness", async () => {
  const [{ auditBilingualObjectiveConsistency }, { auditCrossDocumentEdp }, { summarizePdfPageSignals }] = await Promise.all([
    loadEdpDetailedAudit(),
    loadEdpCrossDocumentAudit(),
    loadEdpReviewEngine(),
  ]);
  const signal = (imageCount = 0, pathPaintCount = 0) => ({ imageCount, pathPaintCount, annotationCount: 0 });
  const document = (role, pages, pageSignals = pages.map(() => signal())) => ({
    role,
    filename: `${role}.pdf`,
    pages,
    pageSignals,
    textQuality: "usable",
  });
  const chinese = document("chinese_edp", [
    "学校名称：测试大学",
    "动力来源：Zn + 2HCl → ZnCl2 + H2，压力 20 kPa。控制机制：I2 + 2S2O3 → 2I + S4O6，15 s 后停止。",
    "安全认证页 Faculty Advisor [signed] Student Alice [signed]",
  ], [signal(), signal(), signal(2)]);
  const english = document("english_edp", [
    "School Name: Test University",
    "Power source: Zn + 2HCl → ZnCl2 + H2 at 20 kPa. Control mechanism: I2 + 2S2O3 → 2I + S4O6, stops after 15 s.",
    "Hazards Analysis | Hazard: corrosive acid | Consequence: burn | Control: goggles and gloves",
    "Laboratory Floor Plan",
    "Vehicle Primary Hazards Checklist | Mechanical hazards: [ ] | Chemical hazards: [x]",
    "Safety Certification Faculty Advisor [signed] Student Alice [signed] | Other mechanical hazards: Yes",
  ], [signal(), signal(), signal(), signal(1), signal(0, 20), signal(2)]);

  const bilingual = auditBilingualObjectiveConsistency([chinese, english]);
  assert.equal(bilingual.status, "yes", "numbers found only in English-exclusive pages must not be compared to Chinese");

  const items = new Map(auditCrossDocumentEdp([chinese, english], { submissionRound: 1 })
    .map((item) => [item.ruleId, item]));
  assert.equal(items.get("hazards_analysis_completed").status, "yes");
  assert.equal(items.get("laboratory_floor_plan").status, "yes", "an embedded diagram on the dedicated floor-plan page satisfies the requested presence check");
  assert.equal(items.get("primary_hazards_checklist").status, "no", "an explicit unchecked box contradicting a later Yes must fail");
  assert.equal(items.get("certification_signatures").status, "needs_human", "typed signed markers do not prove handwriting");
  assert.ok([...items.values()].every((item) => !/中文版.*(?:危险分析|平面图|主要危险|Chemical Information)/u.test(item.suggestedComment)));

  assert.deepEqual(summarizePdfPageSignals(
    [11, 12, 12, 13, 99],
    { paintImageXObject: 11, constructPath: 12, paintInlineImageXObject: 13 },
    [{}, {}],
  ), { imageCount: 2, pathPaintCount: 2, annotationCount: 2 });
});

test("EDP cross-document audit checks chemicals, training, equipment, calculations, waste and MOC", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0, pathPaintCount = 0) => ({ imageCount, pathPaintCount, annotationCount: 0 });
  const document = (role, pages, pageSignals = pages.map(() => signal())) => ({
    role,
    filename: `${role}.pdf`,
    pages,
    pageSignals,
    textQuality: "usable",
  });
  const chinese = document("chinese_edp", [
    "学校名称：测试大学 指导教师姓名：Prof Li",
    "标准操作程序：称取 5 g zinc，量取 10 mL ethanol，与 sodium hydroxide 配制控制液。",
  ]);
  const english = document("english_edp", [
    "School Name: Test University | Faculty Advisor Name: Prof Li",
    "Standard Operating Procedure: use 5 g zinc, 10 mL ethanol and sodium hydroxide. Student: Alice. Student: Bob.",
    "Chemical Information Page | zinc | sodium hydroxide",
    "Equipment List | pump | Manufacturer: ACME | Maximum temperature: 50 C | Maximum pressure: ambient",
    "Discharged Hydrogen Calculations: No hydrogen or other flammable gas is discharged. Pressure Calculations: all components operate at ambient pressure, 0 psig.",
    "Capital Cost of Vehicle Calculations | Motor: 2 x 10 = 20 | Frame: 1 x 30 = 30 | Total: 50",
    "Chemical Waste Table | Waste Stream: zinc solid | Waste Stream: ethanol solvent. Team Waste Tags | Tag 1: zinc solid | Tag 2: ethanol solvent",
  ]);
  const supplement = document("supplement", [
    "Safety Data Sheet (SDS): zinc. Safety Data Sheet (SDS): sodium hydroxide.",
    "AIChE Safety Training Certificate | Alice. AIChE Safety Training Certificate | Bob.",
    "Official manufacturer specification manual | ACME pump | maximum temperature 50 C | ambient pressure",
  ]);
  const moc = document("moc", [
    "MANAGEMENT OF CHANGE REQUEST FORM | Name of Person or Group Requesting Change: Alice | Description of change: revised enclosure | Reason(s) for Change: improve mechanical safety | Impact assessment completed | Requestor Signature [signed]",
    "PROCESS CHANGE REQUEST APPROVAL FORM | Description of Change as Approved: revised enclosure | Faculty Advisor Signature [signed] | Review Signature [signed] | Safety Evaluation Checklist",
  ], [signal(1), signal(2)]);

  const items = new Map(auditCrossDocumentEdp([chinese, english, supplement, moc], { submissionRound: 2, competitionYear: "2026" })
    .map((item) => [item.ruleId, item]));
  assert.equal(items.get("chemical_sds").status, "no");
  assert.match(items.get("chemical_sds").suggestedComment, /乙醇|ethanol/iu);
  assert.equal(items.get("training_certificate_coverage").status, "needs_human");
  assert.match(items.get("training_certificate_coverage").suggestedComment, /日期|年份/u);
  assert.equal(items.get("equipment_list_completeness").status, "yes");
  assert.equal(items.get("hydrogen_calculation_applicability").status, "not_applicable");
  assert.equal(items.get("pressure_calculation_applicability").status, "not_applicable");
  assert.equal(items.get("capital_cost_completeness").status, "yes");
  assert.equal(items.get("waste_tag_consistency").status, "yes");
  assert.equal(items.get("moc").status, "needs_human", "typed signed markers require visual confirmation");
});

test("EDP SDS audit matches every pictured chemical section without requiring a contents page", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0) => ({ imageCount, pathPaintCount: 0, annotationCount: 0 });
  const documents = [
    {
      role: "chinese_edp",
      filename: "中文版EDP.pdf",
      pages: ["动力来源为镁 锰 电 池，控制体系使用酒石酸铁和高锰酸钾。"],
      pageSignals: [signal()],
      textQuality: "usable",
    },
    {
      role: "english_edp",
      filename: "English-EDP.pdf",
      pages: [
        "Power source uses a magnesium-manganese battery. The control reaction uses ferric tartrate and potassium permanganate.",
        "Chemical Information Page Table 1 shipped chemicals: Carbon, Polytetrafluoroethylene, Magnesium chloride, Tartaric acid, potassium permanganate, Iron(III) chloride, Manganese(IV) oxide, Nickel.",
        "Chemical Properties and Hazards Magnesium S Flammable solids. Magnesium chloride S. This later hazard table is not the shipped-chemical inventory.",
        "Continuation of the later hazards table: Magnesium S; PPE: gloves and goggles.",
      ],
      pageSignals: [signal(), signal(), signal(), signal()],
      textQuality: "usable",
    },
    {
      role: "supplement",
      filename: "EDP-Supplement.pdf",
      pages: [
        "1. Carbon",
        "2. Polytetrafluoroethylene",
        "3. Magnesium chloride",
        "4. Tartaric acid",
        "5. potassium permanganate",
        "6. Iron(��) chloride",
        "7. Manganese(IV) oxide",
        "8. Nickel",
      ],
      pageSignals: Array.from({ length: 8 }, () => signal(1)),
      textQuality: "usable",
    },
  ];

  const result = auditCrossDocumentEdp(documents, { submissionRound: 2, competitionYear: "2026" })
    .find(({ ruleId }) => ruleId === "chemical_sds");
  assert.equal(result.status, "yes", result.suggestedComment);
  assert.match(result.suggestedComment, /8\s*项|8\s*种|8\s*\/\s*8/u);
  assert.doesNotMatch(result.suggestedComment, /目录/u);
});

test("EDP SDS audit does not treat a contents-only chemical list as completed SDS documents", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0) => ({ imageCount, pathPaintCount: 0, annotationCount: 0 });
  const documents = [
    {
      role: "english_edp",
      filename: "English-EDP.pdf",
      pages: [
        "Chemical Information Page Table 1 shipped chemicals: Carbon, Polytetrafluoroethylene, Magnesium chloride, Tartaric acid, potassium permanganate, Iron(III) chloride, Manganese(IV) oxide, Nickel.",
      ],
      pageSignals: [signal()],
      textQuality: "usable",
    },
    {
      role: "supplement",
      filename: "EDP-Supplement.pdf",
      pages: [
        "CONTENTS Appendix I: MSDS 1. Carbon 2. Polytetrafluoroethylene 3. Magnesium chloride 4. Tartaric acid 5. potassium permanganate 6. Iron(III) chloride 7. Manganese(IV) oxide 8. Nickel Appendix II: Equipment Specs",
      ],
      pageSignals: [signal()],
      textQuality: "usable",
    },
  ];

  const result = auditCrossDocumentEdp(documents, { submissionRound: 2, competitionYear: "2026" })
    .find(({ ruleId }) => ruleId === "chemical_sds");
  assert.equal(result.status, "no", result.suggestedComment);
  assert.match(result.suggestedComment, /正文|实际.*SDS|分节/u);
});

test("EDP mixed visual evidence accepts current-year certificates, one complete signature language, a floor-plan image and signed MOC", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0, pathPaintCount = 0) => ({ imageCount, pathPaintCount, annotationCount: 0 });
  const document = (role, pages, pageSignals = pages.map(() => signal())) => ({
    role,
    filename: `${role}.pdf`,
    pages,
    pageSignals,
    textQuality: "usable",
  });
  const chinese = document("chinese_edp", [
    "学校名称：测试大学 Faculty Supervisor: 李老师",
    "学院安全规则认证：指导老师签名 日期 2026.5.5。学生安全规则认证：团队已遵守全部安全与竞赛规则，并具有至少10小时操作经验。团队成员签名 日期 2026.5.4 日期 2026.5.4 日期 2026.5.4",
  ], [signal(), signal(4, 24)]);
  const english = document("english_edp", [
    "School Name: Test University Faculty Supervisor: Prof Li",
    "Please list the date the required Chem-E-Car safety training was completed by each team member. Team Member Name Date Alice 2026.5.2 Bob 2026.5.2 Carol 2026.5.4 Faculty Safety Rules Certification",
    "Hazards inherent in design include chemical corrosion, electrical short circuit and mechanical pinch hazards. Each hazard is controlled with containment, insulation, guards, goggles and gloves. We certify that we have followed all of the safety and competition rules. Compared with last year's zinc system, this year's magnesium reaction chemistry and control circuit were changed.",
    "Hazards Analysis Expected Operating Conditions 25 C, 1 atm. Additional Fabrication & Operation Hazard Detail Check List Hazard Present During Control Method(s) PPE Required.",
    "Laboratory Floor Plan/Diagram",
    "Vehicle Primary Hazards Checklist Pressure Chemical Electrical Mechanical Control PPE Required",
    "Standard / Safe Operating Procedures Page Step Sequence Potential Hazard Risk Control Personal Protective Equipment. Emergency Shutdown: switch off power. Run Prep Procedure: measure 10 mL solution and 5 g reagent. Start Procedure: open the prefilled fixed reservoir valve. Stop Procedure: a chemical color change triggers the relay to disconnect motor power. Distance Adjustment Procedure: adjust reagent volume using the calibration curve. Cleanup/Waste Disposal Procedure: collect residue in labelled hazardous waste containers.",
  ], [signal(), signal(), signal(), signal(), signal(1, 5), signal(0, 160), signal(0, 140)]);
  const supplement = document("supplement", [
    "Appendix III: Security certificate",
    "",
  ], [signal(2), signal(1)]);
  const moc = document("moc", [
    "MANAGEMENT OF CHANGE REQUEST FORM Name of Person or Group Requesting Change: Alice Date: 2026.5.23 Summary Description of Change: changed the vehicle enclosure and control procedure. Reason(s) for Change: improve stability. Signature of Requestor:",
    "PROCESS CHANGE REQUEST APPROVAL FORM Description of Change as Approved: revised enclosure and controller. Signatures of Approval Faculty Adviser Date: 2026.5.23 Review Team Member Date: 2026.5.23 Safety Evaluation Checklist risk and impact assessment.",
  ], [signal(2, 20), signal(4, 24)]);

  const items = new Map(auditCrossDocumentEdp([chinese, english, supplement, moc], {
    submissionRound: 2,
    competitionYear: "2026",
  }).map((auditItem) => [auditItem.ruleId, auditItem]));
  for (const ruleId of [
    "certification_signatures",
    "training_certificate_coverage",
    "laboratory_floor_plan",
    "primary_hazards_checklist",
    "moc",
    "hazard_types",
    "jsa",
    "safeguards",
    "rule_violations",
  ]) assert.equal(items.get(ruleId).status, "yes", `${ruleId}: ${items.get(ruleId).suggestedComment}`);

  const staleEnglish = document("english_edp", english.pages.map((page) => page.replaceAll("2026.5.", "2025.5.")), english.pageSignals);
  const staleItems = new Map(auditCrossDocumentEdp([chinese, staleEnglish, supplement, moc], {
    submissionRound: 2,
    competitionYear: "2026",
  }).map((auditItem) => [auditItem.ruleId, auditItem]));
  assert.equal(staleItems.get("training_certificate_coverage").status, "no");
  assert.match(staleItems.get("training_certificate_coverage").suggestedComment, /2025.*2026|竞赛年份/u);
});

test("MOC accepts the requestor and one primary approver signature while unrelated checklist rows stay blank", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0, pathPaintCount = 0) => ({ imageCount, pathPaintCount, annotationCount: 0 });
  const moc = {
    role: "moc",
    filename: "example-MOC.pdf",
    pages: [
      "MANAGEMENT OF CHANGE REQUEST FORM Name of Person or Group Requesting Change: Alice Date: 2026.5.23 Summary Description of Change: revised the vehicle enclosure and controller mounting. Reason(s) for Change: improve stability and prevent loose wiring. Signature of Requestor:",
      "PROCESS CHANGE REQUEST APPROVAL FORM Description of Change as Approved: revised enclosure and controller mounting. Approved Duration of Change: 2026.5.23 Signatures of Approval Faculty Adviser Date: 2026.5.23 Review Team Member Date:",
      "SAFETY EVALUATION CHECKLIST Control Systems: applicable and reviewed. Process Equipment, Operating Conditions and other categories are not involved and remain blank.",
    ],
    pageSignals: [signal(1, 20), signal(1, 24), signal(0, 20)],
    textQuality: "usable",
  };

  const result = auditCrossDocumentEdp([moc], { submissionRound: 2, competitionYear: "2026" })
    .find(({ ruleId }) => ruleId === "moc");
  assert.equal(result.status, "yes", result.suggestedComment);
  assert.match(result.suggestedComment, /申请人.*(?:一名|主要).*签名|主要人员/u);
});

test("MOC rejects a described and signed change when the reason for change is empty", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0, pathPaintCount = 0) => ({ imageCount, pathPaintCount, annotationCount: 0 });
  const moc = {
    role: "moc",
    filename: "missing-reason-MOC.pdf",
    pages: [
      "MANAGEMENT OF CHANGE REQUEST FORM Name of Person or Group Requesting Change: Alice Date: 2026.5.23 Summary Description of Change: revised the vehicle enclosure and controller mounting to improve mechanical stability. Reason(s) for Change: Signature of Requestor:",
      "PROCESS CHANGE REQUEST APPROVAL FORM Description of Change as Approved: revised enclosure and controller mounting. Approved Duration of Change: 2026.5.23 Signatures of Approval Faculty Adviser Date: 2026.5.23 Review Team Member Date:",
      "SAFETY EVALUATION CHECKLIST Control Systems risk and impact assessment completed. Other categories are not involved.",
    ],
    pageSignals: [signal(2, 20), signal(2, 24), signal(0, 20)],
    textQuality: "usable",
  };

  const result = auditCrossDocumentEdp([moc], { submissionRound: 2, competitionYear: "2026" })
    .find(({ ruleId }) => ruleId === "moc");
  assert.equal(result.status, "no", result.suggestedComment);
  assert.match(result.suggestedComment, /原因|Reason/u);
});

test("EDP mixed evidence recognizes completed Dalian-style sections instead of treating filled text as blank", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0, pathPaintCount = 0) => ({ imageCount, pathPaintCount, annotationCount: 0 });
  const document = (role, pages, pageSignals = pages.map(() => signal())) => ({
    role,
    filename: `${role}.pdf`,
    pages,
    pageSignals,
    textQuality: "usable",
  });
  const chinese = document("chinese_edp", [
    "动力来源：镁锰电池。控制机制：酒石酸铁和高锰酸钾。创新点：相比去年的碱性锌锰电池，本年度采用镁锰电池。",
  ]);
  const english = document("english_edp", [
    "Power source uses a magnesium-manganese battery. Stopping mechanism uses ferric tartrate and potassium permanganate.",
    "Hazards Analysis Expected Operating Conditions Normal: 25 C Pressure: 1 atm. Personal Protective Equipment Chemical Gloves Splash Goggles. Available Safety Equipment Fire Extinguisher: beside the door. Eyewash: over the sink.",
    "Additional Fabrication & Operation Hazard Detail Check List Hazard Present During Control Method(s) PPE Required. Hazardous materials: use a blower and keep away from fire. PPE: anti-chemical glasses, masks and gloves. Electrical: insulate welded connections to prevent short circuit. Potential spills: reinforce sealing caps to prevent leakage.",
    "Chemical Information Page Table 1 shipped chemicals: Carbon, Polytetrafluoroethylene, Magnesium chloride, Tartaric acid, potassium permanganate, Iron(III) chloride, Manganese(IV) oxide, Nickel.",
    "Equipment List Equipment Manufacturer Operating Limits Temperature Pressure. Motor Chih 25 C atmospheric pressure.",
    "Capital Cost of Vehicle Calculations Carbon 150 yuan Manganese dioxide 120 yuan PTFE 50 yuan Magnesium chloride 25 yuan Total: 345 yuan",
    "Table 3 Waste Description Magnesium chloride 100ml Aqueous Sodium silicate 500ml Aqueous SDBS 500ml Aqueous Manganese chloride 200ml Aqueous Iron(III) chloride 300ml Aqueous Nickel foam 300g Solid",
    "Team Waste Tags Waste Description: discharged nickel foam Composition: 300g nickel foam. Waste Description: diaphragm waste Composition: magnesium chloride. Waste Description: acidic waste Composition: manganese chloride and Iron(III) chloride. Waste Description: aqueous waste Composition: magnesium chloride, sodium silicate and SDBS.",
  ]);
  const supplement = document("supplement", [
    "CONTENTS Appendix I: MSDS 1. Carbon 2. Polytetrafluoroethylene 3. Magnesium chloride 4. Tartaric acid 5. potassium permanganate 6. Iron(III) chloride 7. Manganese(IV) oxide 8. Nickel Appendix II: Equipment Specs 1. Electrical Parts 2. Mechanical Parts",
    "Equipment Specs Electric machine Manufacturer: Chih Model: XD37GA Rated torque: 2Kg/cm Rated current: 0.8A. Wheel Manufacturer: Suzhou Material: ABS. Acrylic battery box Manufacturer: selfmade Material: acrylic.",
  ]);
  const moc = document("moc", [
    "MANAGEMENT OF CHANGE REQUEST FORM Summary Description of Change: The exterior and control procedure were changed. Reason(s) for Change: more internal space was required. Signature of Requestor: ______",
    "PROCESS CHANGE REQUEST APPROVAL FORM Description of Change as Approved: redesigned vehicle body. Signatures of Approval Faculty Adviser: ____ Review Team Member: ____",
    "SAFETY EVALUATION CHECKLIST Changes in Process Equipment, Operating Conditions, Safety Equipment and Control Systems.",
  ], [signal(1, 20), signal(2, 20), signal(0, 20)]);
  const items = new Map(auditCrossDocumentEdp([chinese, english, supplement, moc], { submissionRound: 2 })
    .map((auditItem) => [auditItem.ruleId, auditItem]));
  assert.equal(items.get("hazards_analysis_completed").status, "yes");
  assert.notEqual(items.get("chemical_sds").status, "needs_human", items.get("chemical_sds").suggestedComment);
  assert.doesNotMatch(items.get("chemical_sds").suggestedComment, /zinc|锌/iu, "a previous-year zinc system is not a current reagent");
  assert.equal(items.get("equipment_list_completeness").status, "yes");
  assert.equal(items.get("capital_cost_completeness").status, "yes");
  assert.equal(items.get("waste_tag_consistency").status, "yes", items.get("waste_tag_consistency").suggestedComment);
  assert.equal(items.get("moc").status, "needs_human", "filled MOC content with graphical signatures is not an empty MOC");
});

test("EDP cross-document audit keeps ambiguous visual marks for human review and catches empty MOC signatures", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const document = (role, pages, pageSignals) => ({ role, filename: `${role}.pdf`, pages, pageSignals, textQuality: "usable" });
  const baseSignal = { imageCount: 0, pathPaintCount: 14, annotationCount: 0 };
  const english = document("english_edp", [
    "School Name: Example University",
    "Vehicle Primary Hazards Checklist | chemical | mechanical | electrical",
    "Safety Certification | Faculty Advisor | Student A",
  ], [{ ...baseSignal }, { ...baseSignal }, { ...baseSignal }]);
  const chinese = document("chinese_edp", ["学校名称：示例大学", "安全认证页 指导教师 学生A"], [{ ...baseSignal }, { ...baseSignal }]);
  const moc = document("moc", [
    "Management of Change Request | Description of change: updated controller | Reason(s) for Change: improve control reliability | Impact assessment | Requestor Signature: | Date:",
  ], [{ imageCount: 0, pathPaintCount: 0, annotationCount: 0 }]);
  const items = new Map(auditCrossDocumentEdp([chinese, english, moc], { submissionRound: 2 })
    .map((item) => [item.ruleId, item]));
  assert.equal(items.get("primary_hazards_checklist").status, "needs_human");
  assert.equal(items.get("certification_signatures").status, "needs_human");
  assert.equal(items.get("moc").status, "no");
  assert.match(items.get("moc").suggestedComment, /申请人|Requestor|签名/u);
});

test("EDP mixed evidence handles flattened real-template text without treating instructions as answers", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const signal = (imageCount = 0, pathPaintCount = 0) => ({ imageCount, pathPaintCount, annotationCount: 0 });
  const document = (role, pages, pageSignals = pages.map(() => signal())) => ({
    role,
    filename: `${role}.pdf`,
    pages,
    pageSignals,
    textQuality: "usable",
  });
  const chinese = document("chinese_edp", [
    "学校名称：测试大学。动力来源使用锌、硫酸镍、铁氰化钾、氯化铝、琼脂和炭黑。控制反应使用乳酸乙酯、氢氧化钠和百里酚酞，并生成乙醇。",
    "安全规则认证 指导教师及全体学生签名",
    "签名续页",
  ], [signal(), signal(1), signal(1)]);
  const english = document("english_edp", [
    "School Name: Test University Faculty Supervisor: Prof Li. This system has no auxiliary processes such as hydrogen production or fuel synthesis.",
    "Power source uses zinc, nickel sulfate, potassium ferricyanide, aluminum chloride, agar and carbon black. Stopping mechanism uses ethyl lactate, sodium hydroxide and thymolphthalein and produces ethanol.",
    "Faculty Safety Rules Certification Faculty Advisor Name: Prof Li Faculty Advisor Signature Date 2026-05-23 Student Safety Rules Certification",
    "Student signature continuation page",
    "Hazards Analysis Expected Operating Conditions Normal: 0 psig. Available Safety Equipment Fire Extinguisher: Near the door Eyewash: Near the sink Spill Kit: In the cabinet.",
    "Additional Fabrication & Operation Hazard Detail Check List Hazard Present During Control Method(s) PPE Required Hazardous materials Yes Yes Use secondary containment and segregated waste. Goggles and chemical gloves.",
    "Chemical Information Page Chemical Name zinc nickel sulfate potassium ferricyanide aluminum chloride agar carbon black ethyl lactate sodium hydroxide thymolphthalein ethanol. Incompatible chemicals: acids may release HCl.",
    "Equipment List Equipment Manufacturer Operating Limits Temperature Pressure. Pump Manufacturer: unknown.",
    "Discharged Hydrogen (or other flammable chemicals) Calculations If your car does not use hydrogen, then this section should be left blank.",
    "Pressure Calculations If your car does not generate pressure above 5 psig (0.345 barg), you may leave this section blank.",
    "Capital Cost of Vehicle Calculations 商品名 规格 RMB(元) 价格($) A — 44.85 6.41 B 500g 48.75 6.94 总计 — 93.60 13.35",
    "Table 3 Waste Description Concentration Amount Disposal Waste Stream A 20-40 g Solids [pH 6-9] B 10 mL Organic C 100 mL Base D 100 mL Organic",
    "Team Waste Tags Team Name: Test No.:2 Waste Description: B Team Name: Test No.:1 Waste Description: A",
  ], [signal(), signal(), signal(1), signal(1), signal(), signal(), signal(), signal(), signal(), signal(), signal(), signal(), signal()]);
  const supplement = document("supplement", [
    "化学品安全技术说明书 产品名称：锌 zinc；硫酸镍 nickel sulfate；铁氰化钾 potassium ferricyanide；氯化铝 aluminum chloride；琼脂 agar；炭黑 carbon black。",
    "化学品安全技术说明书 产品名称：乳酸乙酯 ethyl lactate；氢氧化钠 sodium hydroxide；百里酚酞 thymolphthalein。",
    "AIChE's ChemE Car Safety Course Student One",
  ]);
  const moc = document("moc", [
    "MANAGEMENT OF CHANGE REQUEST FORM Summary Description of Change: revised control procedure. Reason(s) for Change: improve control reliability. Impact and risk assessment completed. Signature note: approval and requestor signature lines are intentionally left blank in this prepared form.",
  ], [signal(1)]);

  const items = new Map(auditCrossDocumentEdp([chinese, english, supplement, moc], { submissionRound: 2 })
    .map((auditItem) => [auditItem.ruleId, auditItem]));
  assert.equal(items.get("certification_signatures").status, "needs_human", "visual signatures must be reviewed, not rejected as a missing English page");
  assert.equal(items.get("hazards_analysis_completed").status, "yes");
  assert.equal(items.get("chemical_sds").status, "no");
  assert.match(items.get("chemical_sds").suggestedComment, /乙醇|ethanol/iu);
  assert.doesNotMatch(items.get("chemical_sds").suggestedComment, /盐酸|hydrochloric/iu, "an incompatibility note must not turn HCl into a used chemical");
  assert.equal(items.get("training_certificate_coverage").status, "needs_human", "the student roster is embedded as an image");
  assert.match(items.get("training_certificate_coverage").suggestedComment, /日期|年份/u);
  assert.equal(items.get("equipment_list_completeness").status, "no");
  assert.equal(items.get("hydrogen_calculation_applicability").status, "not_applicable");
  assert.equal(items.get("pressure_calculation_applicability").status, "not_applicable");
  assert.equal(items.get("capital_cost_completeness").status, "yes");
  assert.equal(items.get("waste_tag_consistency").status, "no");
  assert.match(items.get("waste_tag_consistency").suggestedComment, /4.*2/u);
  assert.equal(items.get("moc").status, "no");
  assert.match(items.get("moc").suggestedComment, /申请人|Requestor|签名/u);
});

test("EDP scanned supporting pages prevent false missing-SDS and certificate failures", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const documents = [
    { role: "chinese_edp", filename: "cn.pdf", pages: ["动力来源 zinc，控制机制 ethanol"], textQuality: "usable" },
    { role: "english_edp", filename: "en.pdf", pages: ["Faculty Advisor Name: Prof Li\nStudent: Alice", "Chemical Information Page zinc ethanol"], textQuality: "usable" },
    { role: "supplement", filename: "supp.pdf", pages: ["Safety Data Sheet zinc", ""], pageSignals: [{ imageCount: 0 }, { imageCount: 1 }], textQuality: "usable" },
  ];
  const items = new Map(auditCrossDocumentEdp(documents, { submissionRound: 1 }).map((item) => [item.ruleId, item]));
  for (const id of ["chemical_sds", "training_certificate_coverage"]) {
    assert.equal(items.get(id).status, "needs_human");
    assert.ok(items.get(id).evidence.some((entry) => entry.filename === "supp.pdf" && entry.page === 2));
  }
  const { buildEdpReviewWorkbook } = await loadEdpReviewWorkbook();
  const generated = await buildEdpReviewWorkbook(await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url)), {
    schoolName: "扫描样例大学", competitionYear: "2026", submissionRound: 1,
    reviewedAt: "2026-09-05T00:00:00Z", overallStatus: "needs_human",
    safetyReviewerName: "", safetyReviewerEmail: "", expertMemberName: "",
    items: [...items.values()].map((item) => ({ ...item, comment: item.suggestedComment })),
  });
  const workbook = XLSX.read(generated, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["1) EDP Cover Page", "2) EDP Evaluation"]);
  assert.equal(workbook.Sheets["2) EDP Evaluation"].B5.v, "待人工确认");
  assert.match(workbook.Sheets["2) EDP Evaluation"].D5.v, /supp.pdf.*第2页/u);
});

test("VS Code dev binds static assets for the actual Excel template loader", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /assets:\s*\{\s*binding:\s*"ASSETS"/u);
});

test("EDP bounded visual reads do not claim that omitted images are missing", async () => {
  const { auditCrossDocumentEdp } = await loadEdpCrossDocumentAudit();
  const limited = {imageCount: 0, pathPaintCount: 0, annotationCount: 0, visualReadLimited: true};
  const documents = [
    {role: "chinese_edp", filename: "cn.pdf", pages: ["动力来源 zinc，控制机制 ethanol"], textQuality: "usable"},
    {role: "english_edp", filename: "en.pdf", pages: ["Safety Certification Page Student Signature Faculty Signature", "Laboratory Floor Plan", "Chemical Information Page zinc ethanol"], pageSignals: [limited, limited, limited], textQuality: "usable"},
    {role: "supplement", filename: "supp.pdf", pages: [""], pageSignals: [limited], textQuality: "empty"},
  ];
  const items = new Map(auditCrossDocumentEdp(documents, {submissionRound: 1}).map(item => [item.ruleId, item]));
  for (const id of ["certification_signatures", "laboratory_floor_plan", "chemical_sds", "training_certificate_coverage"]) {
    assert.equal(items.get(id).status, "needs_human", id);
  }
  assert.equal(items.get("moc").status, "not_applicable");
});

test("EDP SOP slash heading limits quantity checks to the SOP section", async () => {
  const {auditDetailedEdpDocuments} = await loadEdpDetailedAudit();
  const document = {role: "chinese_edp", filename: "cn.pdf", textQuality: "usable", pages: [
    "辅助过程：按需咨询。标准/安全操作页：步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品。称取 5 g 锌，量取 10 mL 盐酸。近五年方案：无。"
  ]};
  const items = auditDetailedEdpDocuments([document], {competitionYear: "2026"});
  assert.equal(items.find(item => item.ruleId === "sop_quantification").status, "yes");
});

test("EDP audit archive parity across ZIP, 7z and RAR ignores registration sidecars", async () => {
  const { auditEdpArchive } = await loadEdpReviewEngine();
  const zip = new JSZip();
  for (const filename of ["Chinese-EDP.pdf", "English-EDP.pdf", "EDP-Supplement.pdf", "MOC.pdf"]) {
    zip.file(`Nanjing-Tech/${filename}`, new TextEncoder().encode("%PDF-1.7\nsynthetic"));
  }
  zip.file("Nanjing-Tech/南京工业大学-报名表.xlsx", registrationWorkbookBytes("南京工业大学"));
  const samples = [
    { filename: "南京工业大学.zip", bytes: await zip.generateAsync({ type: "uint8array" }) },
    { filename: "南京工业大学.7z", bytes: new Uint8Array(await readFile(new URL("./fixtures/edp/nested-round2.7z", import.meta.url))) },
    { filename: "中国海洋大学.rar", bytes: new Uint8Array(await readFile(new URL("./fixtures/edp/nested-round2.rar", import.meta.url))) },
  ];
  const extractDocument = async (filename, _bytes, role) => ({
    role,
    filename,
    pages: [`deterministic ${role} evidence`],
    textQuality: "usable",
  });
  globalThis.__CHEMECAR_TEST_READ_LIBARCHIVE__ = readLibarchiveEntriesForTest;
  try {
    const results = [];
    for (const sample of samples) {
      results.push(await auditEdpArchive(sample.bytes, {
        archiveFilename: sample.filename,
        submissionRound: 2,
        extractDocument,
      }));
    }
    const expectedRoles = ["chinese_edp", "english_edp", "moc", "supplement"];
    const expectedRuleIds = results[0].items.map(({ ruleId }) => ruleId);
    for (const result of results) {
      assert.deepEqual(result.documents.map(({ role }) => role).sort(), expectedRoles);
      assert.deepEqual(result.items.map(({ ruleId }) => ruleId), expectedRuleIds);
      assert.equal(result.overallStatus, results[0].overallStatus);
    }
  } finally {
    delete globalThis.__CHEMECAR_TEST_READ_LIBARCHIVE__;
  }
});

test("optional local EDP archive exercises the real PDF evidence extractor", {
  skip: !process.env.EDP_SAMPLE_ZIP,
}, async () => {
  const { auditEdpArchive } = await loadEdpReviewEngine();
  const sampleBytes = await readFile(process.env.EDP_SAMPLE_ZIP);
  const result = await auditEdpArchive(sampleBytes, {
    archiveFilename: process.env.EDP_SAMPLE_ZIP,
    submissionRound: 2,
    competitionYear: "2026",
  });
  console.log("LOCAL_EDP_DOCUMENTS", JSON.stringify({
    warnings: result.warnings,
    documents: result.documents.map(({ filename, pages, pageSignals, textQuality }) => ({ filename, pageCount: pages.length, signalCount: pageSignals?.length ?? 0, textQuality })),
  }, null, 2));
  assert.equal(result.documents.length, 4);
  assert.ok(result.documents.every(({ pageSignals, pages }) => pageSignals?.length === pages.length));
  assert.ok(result.items.every(({ suggestedComment }) => !/中文版.*(?:危险分析|平面图|主要危险|Chemical Information)/u.test(suggestedComment)));
  if (/大连理工大学-第二次EDP\.zip$/u.test(process.env.EDP_SAMPLE_ZIP)) {
    // Real archive inputs stay private. Exact extraction is covered by the
    // synthetic identity fixture above, not personal values in public source.
    assert.ok(result.workbookIdentity.workName.trim());
    assert.ok(result.workbookIdentity.instructorName.trim());
    assert.match(result.workbookIdentity.instructorEmail,
      /^[^\s@]+@[^\s@]+\.[^\s@]+(?:\s+[^\s@]+@[^\s@]+\.[^\s@]+)*$/u);
    const realItems = new Map(result.items.map((item) => [item.ruleId, item]));
    for (const ruleId of [
      "chemical_sds",
      "hazards_analysis_completed",
      "equipment_list_completeness",
      "capital_cost_completeness",
      "waste_tag_consistency",
      "certification_signatures",
      "training_certificate_coverage",
      "laboratory_floor_plan",
      "primary_hazards_checklist",
      "moc",
      "hazard_types",
      "jsa",
      "safeguards",
      "rule_violations",
    ]) assert.equal(realItems.get(ruleId).status, "yes", `${ruleId}: ${realItems.get(ruleId).suggestedComment}`);
    assert.match(realItems.get("chemical_sds").suggestedComment, /8\s*种/u);
    assert.deepEqual(
      realItems.get("chemical_sds").evidence.map(({ page }) => page),
      [5, 17, 28, 39, 54, 70, 86, 100],
    );
    for (const row of [29, 30, 31, 32]) {
      const rowItems = result.items.filter((item) => item.row === row);
      assert.ok(rowItems.length > 0, `row ${row} must contain audit evidence`);
      assert.ok(rowItems.every(({ status }) => status === "yes" || status === "not_applicable"),
        `row ${row}: ${rowItems.map(({ ruleId, status }) => `${ruleId}=${status}`).join(", ")}`);
    }
    assert.equal(realItems.get("pressure_calculation_applicability").status, "not_applicable",
      realItems.get("pressure_calculation_applicability").suggestedComment);
    const { buildEdpReviewWorkbook } = await loadEdpReviewWorkbook();
    const workbookBytes = await buildEdpReviewWorkbook(
      await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url)),
      {
        schoolName: "大连理工大学",
        competitionYear: "2026",
        submissionRound: 2,
        reviewedAt: "2026-09-09T00:00:00Z",
        overallStatus: result.overallStatus,
        ...result.workbookIdentity,
        safetyReviewerName: "潘芳丽",
        safetyReviewerEmail: "service@chemecar.cn",
        expertMemberName: "华炜",
        items: result.items.map((item) => ({ ...item, comment: item.suggestedComment })),
      },
    );
    const workbook = XLSX.read(workbookBytes, { type: "array" });
    for (const cell of ["C20", "C21", "C22"]) {
      assert.equal(workbook.Sheets["1) EDP Cover Page"][cell].v, "是", `cover ${cell}`);
    }
    for (const row of [29, 30, 31, 32]) {
      assert.equal(workbook.Sheets["2) EDP Evaluation"][`B${row}`].v, "是", `evaluation B${row}`);
    }
  }
  const ids = new Set(result.items.map(({ ruleId }) => ruleId));
  for (const ruleId of [
    "hazards_analysis_completed",
    "laboratory_floor_plan",
    "primary_hazards_checklist",
    "chemical_sds",
    "training_certificate_coverage",
    "equipment_list_completeness",
    "hydrogen_calculation_applicability",
    "pressure_calculation_applicability",
    "capital_cost_completeness",
    "waste_tag_consistency",
    "moc",
  ]) assert.ok(ids.has(ruleId), ruleId);
  console.log("LOCAL_EDP_AUDIT", JSON.stringify(result.items
    .filter(({ ruleId }) => [
      "hazards_analysis_completed", "laboratory_floor_plan", "primary_hazards_checklist",
      "chemical_sds", "training_certificate_coverage", "equipment_list_completeness",
      "hydrogen_calculation_applicability", "pressure_calculation_applicability",
      "capital_cost_completeness", "waste_tag_consistency", "certification_signatures", "moc",
    ].includes(ruleId))
    .map(({ ruleId, status, suggestedComment, evidence }) => ({ ruleId, status, suggestedComment, evidence: evidence.slice(0, 2) })), null, 2));
});

test("EDP audit engine extracts role-scoped evidence and refuses incomplete or unreadable archives", async () => {
  const {
    EDP_AUDIT_RULE_IDS,
    EdpAuditArchiveError,
    auditEdpArchive,
    computeOverallReviewStatus,
  } = await loadEdpReviewEngine();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const archiveBytes = async (files) => {
    const archive = new JSZip();
    for (const [filename, text] of Object.entries(files)) archive.file(filename, encoder.encode(`%PDF-1.7\n${text}`));
    return archive.generateAsync({ type: "uint8array" });
  };
  const textExtractor = async (filename, bytes, role) => {
    const text = decoder.decode(bytes).replace(/^%PDF-[^\n]*\n/u, "");
    return { role, filename, pages: [text], textQuality: text.trim() ? "usable" : "empty" };
  };

  const firstRound = await auditEdpArchive(await archiveBytes({
    "天津大学-中文版EDP.pdf": "本项目使用锌，全部反应物和产物均附有安全数据表 SDS，且不使用含铅电池。作业安全分析 JSA 包含危害、风险和控制措施。",
    "天津大学-English-EDP.pdf": "Chemical Information Page: zinc. Maximum operating pressure MOP is not greater than 500 psig.",
    "天津大学-EDP增补文件.pdf": "Safety Data Sheet SDS: zinc. 制造商规格资料。",
  }), { archiveFilename: "EDP.zip", submissionRound: 1, extractDocument: textExtractor });
  assert.equal(firstRound.documents.length, 3);
  assert.equal(firstRound.items.length, EDP_AUDIT_RULE_IDS.length);
  assert.equal(new Set(firstRound.items.map(({ ruleId }) => ruleId)).size, firstRound.items.length, "strict rules must replace legacy rules without duplicate database keys");
  assert.equal(firstRound.items.find(({ ruleId }) => ruleId === "chemical_sds").status, "yes");
  assert.equal(firstRound.items.find(({ ruleId }) => ruleId === "moc").status, "not_applicable");
  assert.ok(firstRound.items.some(({ ruleId }) => ruleId === "cover_required_fields"));
  assert.ok(firstRound.items.some(({ ruleId }) => ruleId === "bilingual_objective_consistency"));
  assert.ok(firstRound.items.some(({ ruleId }) => ruleId === "waste_handling_detail"));
  assert.equal(firstRound.overallStatus, "failed", "missing required cover and detailed evidence must fail the audit");

  const conflict = await auditEdpArchive(await archiveBytes({
    "天津大学-中文版EDP.pdf": "最大操作压力 MOP 不超过 500 psig。",
    "天津大学-English-EDP.pdf": "Maximum operating pressure information.",
    "天津大学-EDP增补文件.pdf": "最大操作压力 MOP 超过 500 psig。",
  }), { archiveFilename: "EDP.zip", submissionRound: 1, extractDocument: textExtractor });
  const pressure = conflict.items.find(({ ruleId }) => ruleId === "max_pressure_500psig");
  assert.equal(pressure.status, "needs_human");
  assert.ok(pressure.evidence.length >= 2);

  const scanned = await auditEdpArchive(await archiveBytes({
    "天津大学-中文版EDP.pdf": "",
    "天津大学-English-EDP.pdf": "",
    "天津大学-EDP增补文件.pdf": "",
  }), { archiveFilename: "EDP.zip", submissionRound: 1, extractDocument: textExtractor });
  assert.equal(scanned.items.find(({ ruleId }) => ruleId === "chemical_sds").status, "needs_human");
  assert.ok(scanned.warnings.some((warning) => /无法可靠提取文字/u.test(warning)));

  await assert.rejects(
    async () => auditEdpArchive(await archiveBytes({
      "天津大学-中文版EDP.pdf": "中文版内容",
      "天津大学-English-EDP.pdf": "English content",
      "天津大学-EDP增补文件.pdf": "增补内容",
    }), { archiveFilename: "EDP.zip", submissionRound: 2, extractDocument: textExtractor }),
    (error) => error instanceof EdpAuditArchiveError && error.code === "package_invalid",
  );

  assert.equal(computeOverallReviewStatus([{ status: "yes" }, { status: "not_applicable" }]), "passed");
  assert.equal(computeOverallReviewStatus([{ status: "yes" }, { status: "no" }, { status: "needs_human" }]), "failed");
  assert.equal(computeOverallReviewStatus([{ status: "yes" }, { status: "needs_human" }]), "needs_human");
});

test("syncs missing EDP review jobs idempotently and reports only unresolved legacy rounds", async () => {
  const [worker, cookie] = await Promise.all([loadWorker(), authenticatedCookie()]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "edp-review-sync-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    const env = await makeAuthEnv({ DB: database, FILES: new FakeR2() });
    const initialize = await callApi(worker, env, "/api/edp-reviews/settings", { cookie });
    assert.equal(initialize.status, 200);
    const receiptSettings = await callApi(worker, env, "/api/edp-receipt-settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitionYear: "2026", submissionRound: 4 }),
    });
    assert.equal(receiptSettings.status, 200);

    const insertSubmission = async ({ schoolKey, schoolName, submissionId, fileCount, round, source, format }) => {
      await database.prepare(`INSERT INTO edp_submissions (
        user_id, school_key, school_name, r2_key, filename, content_type, submitted_at,
        submission_id, size, file_count, uploaded_at, submission_round,
        submission_round_source, archive_format
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          "shared-browser-workspace",
          schoolKey,
          schoolName,
          `users/shared-browser-workspace/edp/${schoolKey}/current.zip`,
          `${schoolName}.${format}`,
          format === "7z" ? "application/x-7z-compressed" : format === "rar" ? "application/vnd.rar" : "application/zip",
          `2026-08-0${submissionId}T08:00:00.000Z`,
          submissionId,
          100,
          fileCount,
          "2026-08-10T00:00:00.000Z",
          round,
          source,
          format,
        ).run();
    };
    await insertSubmission({ schoolKey: "captured", schoolName: "捕获轮次大学", submissionId: "1", fileCount: 4, round: 2, source: "captured", format: "7z" });
    await insertSubmission({ schoolKey: "legacy-three", schoolName: "三文件大学", submissionId: "2", fileCount: 3, round: null, source: "legacy_unknown", format: "zip" });
    await insertSubmission({ schoolKey: "legacy-four", schoolName: "四文件大学", submissionId: "3", fileCount: 4, round: null, source: "legacy_unknown", format: "rar" });

    const sync = async () => {
      const response = await callApi(worker, env, "/api/edp-reviews/sync", {
        method: "POST", origin: AUTH_ORIGIN, cookie,
      });
      return { response, payload: await response.json() };
    };
    const first = await sync();
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.deepEqual(first.payload.summary, {
      created: 3,
      existing: 0,
      failed: 0,
      historicalRoundInferences: 2,
      failures: [],
    });
    const second = await sync();
    assert.equal(second.response.status, 200, JSON.stringify(second.payload));
    assert.deepEqual(second.payload.summary, {
      created: 0,
      existing: 3,
      failed: 0,
      historicalRoundInferences: 0,
      failures: [],
    });
    assert.equal((await database.prepare("SELECT submission_round, submission_round_source FROM edp_submissions WHERE school_key = 'legacy-three'").first()).submission_round, 1);
    assert.equal((await database.prepare("SELECT submission_round_source FROM edp_submissions WHERE school_key = 'legacy-four'").first()).submission_round_source, "inferred_current_setting");

    const listed = await callApi(worker, env, "/api/edp-reviews", { cookie });
    const listedPayload = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedPayload.jobs.find(({ schoolKey }) => schoolKey === "captured").archiveFormat, "7z");
    assert.equal(listedPayload.jobs.find(({ schoolKey }) => schoolKey === "legacy-four").submissionRoundSource, "inferred_current_setting");

    await database.prepare("DELETE FROM edp_receipt_settings WHERE user_id = ?").bind("shared-browser-workspace").run();
    await insertSubmission({ schoolKey: "unresolved-four", schoolName: "轮次待确认大学", submissionId: "4", fileCount: 4, round: null, source: "legacy_unknown", format: "zip" });
    const unresolved = await sync();
    assert.equal(unresolved.response.status, 200, JSON.stringify(unresolved.payload));
    assert.equal(unresolved.payload.summary.created, 0);
    assert.equal(unresolved.payload.summary.existing, 3);
    assert.equal(unresolved.payload.summary.failed, 1);
    assert.equal(unresolved.payload.summary.historicalRoundInferences, 0);
    assert.deepEqual(unresolved.payload.summary.failures.map(({ schoolKey }) => schoolKey), ["unresolved-four"]);
  } finally {
    await miniflare.dispose();
  }
});

test("fixed EDP review personnel ignore client overrides and leave expert email blank", async () => {
  const [worker, cookie, { buildEdpReviewWorkbook }] = await Promise.all([
    loadWorker(),
    authenticatedCookie(),
    loadEdpReviewWorkbook(),
  ]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "fixed-edp-review-personnel-test" },
  });
  try {
    const env = await makeAuthEnv({ DB: await miniflare.getD1Database("DB"), FILES: new FakeR2() });
    const saved = await callApi(worker, env, "/api/edp-reviews/settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        competitionYear: "2026",
        safetyReviewerName: "错误姓名",
        safetyReviewerEmail: "wrong@example.com",
        expertMemberName: "错误专家",
        expertMemberEmail: "wrong-expert@example.com",
      }),
    });
    const savedPayload = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedPayload));
    assert.equal(savedPayload.settings.safetyReviewerName, "潘芳丽");
    assert.equal(savedPayload.settings.safetyReviewerEmail, "service@chemecar.cn");
    assert.equal(savedPayload.settings.expertMemberName, "华炜");
    assert.equal(savedPayload.settings.expertMemberEmail, "");

    const loaded = await callApi(worker, env, "/api/edp-reviews/settings", { cookie });
    const settings = (await loaded.json()).settings;
    assert.equal(settings.safetyReviewerName, "潘芳丽");
    assert.equal(settings.safetyReviewerEmail, "service@chemecar.cn");
    assert.equal(settings.expertMemberName, "华炜");
    const generated = await buildEdpReviewWorkbook(
      await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url)),
      {
        schoolName: "天津大学",
        competitionYear: settings.competitionYear,
        submissionRound: 2,
        reviewedAt: "2026-09-06T12:00:00.000Z",
        overallStatus: "needs_human",
        safetyReviewerName: settings.safetyReviewerName,
        safetyReviewerEmail: settings.safetyReviewerEmail,
        expertMemberName: settings.expertMemberName,
        items: [],
      },
    );
    const workbook = XLSX.read(generated, { type: "array" });
    assert.deepEqual(workbook.SheetNames, ["1) EDP Cover Page", "2) EDP Evaluation"]);
    const cover = workbook.Sheets["1) EDP Cover Page"];
    assert.equal(cover.E8.v, "潘芳丽");
    assert.equal(cover.E9.v, "service@chemecar.cn");
    assert.equal(cover.E10.v, "华炜");
    assert.equal(cover.E11?.v ?? "", "");
  } finally {
    await miniflare.dispose();
  }
});

test("EDP review API lifecycle and EDP review export preserve history and block unresolved formal files", async () => {
  const { EDP_AUDIT_RULE_IDS } = await loadEdpReviewEngine();
  const [worker, cookie] = await Promise.all([
    loadWorker(),
    authenticatedCookie(),
  ]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "edp-review-api-test" },
  });
  const files = new FakeR2();
  try {
    const database = await miniflare.getD1Database("DB");
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const reviewTemplateBytes = await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url));
    env.ASSETS = {
      fetch: async (request) => new URL(request.url).pathname === "/edp-review-template-v1.xlsx"
        ? new Response(reviewTemplateBytes)
        : new Response("Not found", { status: 404 }),
    };
    const receiptSettings = await callApi(worker, env, "/api/edp-receipt-settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitionYear: "2026", submissionRound: 1 }),
    });
    assert.equal(receiptSettings.status, 200);

    const reviewSettings = await callApi(worker, env, "/api/edp-reviews/settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        competitionYear: "2026",
        safetyReviewerName: "安全审核员",
        safetyReviewerEmail: "safety@example.edu.cn",
        expertMemberName: "专家组成员",
        expertMemberEmail: "expert@example.edu.cn",
      }),
    });
    assert.equal(reviewSettings.status, 200);

    const upload = async (submittedAt, submissionId, schoolName = "华东理工大学") => {
      const form = new FormData();
      form.set("file", await makeEdpZip());
      form.set("schoolName", schoolName);
      form.set("submittedAt", submittedAt);
      form.set("submissionId", submissionId);
      const response = await callApi(worker, env, "/api/edp-submissions", {
        method: "POST", origin: AUTH_ORIGIN, cookie, body: form,
      });
      return { response, payload: await response.json() };
    };
    const first = await upload("2026-08-01T08:00:00.000Z", "review-1");
    assert.equal(first.response.status, 201, JSON.stringify(first.payload));
    assert.equal(first.payload.reviewJob.status, "queued");

    const listResponse = await callApi(worker, env, "/api/edp-reviews", { origin: AUTH_ORIGIN, cookie });
    const listPayload = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listPayload.jobs.length, 1);
    assert.equal(listPayload.jobs[0].submissionId, "review-1");

    const jobId = listPayload.jobs[0].jobId;
    const run = await callApi(worker, env, `/api/edp-reviews/${jobId}/run`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    const runPayload = await run.json();
    assert.equal(run.status, 200, JSON.stringify(runPayload));
    assert.equal(runPayload.job.status, "needs_human");
    assert.equal(runPayload.items.length, EDP_AUDIT_RULE_IDS.length);
    assert.ok(runPayload.items.every((item) => Array.isArray(item.evidence)));
    const deferredPhotoItem = runPayload.items.find(({ ruleId }) => ruleId === "vehicle_photo");
    assert.equal(deferredPhotoItem.isBlocking, false);
    assert.equal(deferredPhotoItem.ruleSource, "builtin:v1");
    assert.match(deferredPhotoItem.suggestedComment, /暂缓审核.*不阻塞/u);

    const unresolvedFinalize = await callApi(worker, env, `/api/edp-reviews/${jobId}/finalize`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(unresolvedFinalize.status, 409);
    const draftExport = await callApi(worker, env, `/api/edp-reviews/${jobId}/exports/draft`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    const draftPayload = await draftExport.json();
    assert.equal(draftExport.status, 201, JSON.stringify(draftPayload));
    assert.match(draftPayload.export.filename, /__草稿\.xlsx$/u);
    assert.ok(files.objects.has(draftPayload.export.r2Key));
    const blockedFinalExport = await callApi(worker, env, `/api/edp-reviews/${jobId}/exports/final`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(blockedFinalExport.status, 409);

    const noComment = await callApi(worker, env, `/api/edp-reviews/${jobId}/items/chemical_sds`, {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "no", comment: "" }),
    });
    assert.equal(noComment.status, 400);
    const override = await callApi(worker, env, `/api/edp-reviews/${jobId}/items/chemical_sds`, {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "no", comment: "安全数据表缺少明确对应关系，需补充。" }),
    });
    assert.equal(override.status, 200);
    const storedOverride = await database.prepare(`SELECT final_status, final_comment, override_actor,
      override_previous_status, overridden_at FROM edp_review_items WHERE user_id = ? AND job_id = ? AND rule_id = ?`)
      .bind("shared-browser-workspace", jobId, "chemical_sds").first();
    assert.equal(storedOverride.final_status, "no");
    assert.equal(storedOverride.override_actor, "shared-operator");
    assert.equal(storedOverride.override_previous_status, "needs_human", "unreadable source text must remain a human-review baseline");
    assert.ok(storedOverride.overridden_at);

    await database.prepare("UPDATE edp_review_items SET final_status = 'yes', final_comment = '人工已核对' WHERE user_id = ? AND job_id = ?")
      .bind("shared-browser-workspace", jobId).run();
    const recalculate = await callApi(worker, env, `/api/edp-reviews/${jobId}/items/moc`, {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "no", comment: "MOC 内容为空或未填写变更内容及影响/风险分析。" }),
    });
    assert.equal(recalculate.status, 200);
    const recalculatedPayload = await recalculate.json();
    assert.equal(recalculatedPayload.items.find(({ ruleId }) => ruleId === "moc").finalStatus, "not_applicable");
    assert.match(recalculatedPayload.items.find(({ ruleId }) => ruleId === "moc").finalComment, /第1次.*不要求 MOC/u);
    assert.equal(recalculatedPayload.job.overallStatus, "passed");
    const finalized = await callApi(worker, env, `/api/edp-reviews/${jobId}/finalize`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(finalized.status, 200);
    assert.equal((await finalized.json()).job.status, "completed");
    const finalExport = await callApi(worker, env, `/api/edp-reviews/${jobId}/exports/final`, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
    });
    const finalPayload = await finalExport.json();
    assert.equal(finalExport.status, 201, JSON.stringify(finalPayload));
    assert.doesNotMatch(finalPayload.export.filename, /草稿/u);
    const finalDownload = await callApi(worker, env, `/api/edp-reviews/${jobId}/exports/final/download`, {
      origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(finalDownload.status, 200);
    const downloadedWorkbook = XLSX.read(await finalDownload.arrayBuffer(), { type: "array" });
    assert.deepEqual(downloadedWorkbook.SheetNames, ["1) EDP Cover Page", "2) EDP Evaluation"]);
    assert.equal(downloadedWorkbook.Sheets["1) EDP Cover Page"].E4.v, "华东理工大学");
    assert.equal(downloadedWorkbook.Sheets["1) EDP Cover Page"].E5?.v ?? "", "Roadrunner", JSON.stringify(runPayload.job));
    assert.equal(downloadedWorkbook.Sheets["1) EDP Cover Page"].E6.v, "Professor Li");
    assert.equal(downloadedWorkbook.Sheets["1) EDP Cover Page"].E7.v, "professor.li@example.edu.cn");
    assert.match(downloadedWorkbook.Sheets["1) EDP Cover Page"].D16.v, /内置 EDP 审核规则.*v1/u);
    const deleteDraft = await callApi(worker, env, `/api/edp-reviews/${jobId}/exports/draft`, {
      method: "DELETE", origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(deleteDraft.status, 200);
    assert.equal(files.objects.has(draftPayload.export.r2Key), false);

    const second = await upload("2026-08-02T08:00:00.000Z", "review-2");
    assert.equal(second.response.status, 200, JSON.stringify(second.payload));
    assert.equal(second.payload.reviewJob.submissionId, "review-2");
    assert.notEqual(second.payload.reviewJob.jobId, jobId);
    assert.equal((await database.prepare("SELECT status FROM edp_review_jobs WHERE user_id = ? AND job_id = ?")
      .bind("shared-browser-workspace", jobId).first()).status, "superseded");
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_review_jobs WHERE user_id = ?")
      .bind("shared-browser-workspace").first()).total, 2, "new submissions must preserve prior review history");

    const staleDelete = await callApi(worker, env, `/api/edp-reviews/${encodeURIComponent(jobId)}`, {
      method: "DELETE", origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(staleDelete.status, 409, "an older review row must never delete the current EDP");
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_submissions WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", second.payload.reviewJob.schoolKey).first()).total, 1);

    const currentSource = await database.prepare("SELECT r2_key FROM edp_submissions WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", second.payload.reviewJob.schoolKey).first();
    assert.ok(currentSource?.r2_key && files.objects.has(currentSource.r2_key));
    assert.ok(files.objects.has(finalPayload.export.r2Key));
    const deletedEdp = await callApi(worker, env, `/api/edp-reviews/${encodeURIComponent(second.payload.reviewJob.jobId)}`, {
      method: "DELETE", origin: AUTH_ORIGIN, cookie,
    });
    const deletedPayload = await deletedEdp.json();
    assert.equal(deletedEdp.status, 200, JSON.stringify(deletedPayload));
    assert.equal(deletedPayload.deleted, true);
    assert.equal(deletedPayload.schoolName, "华东理工大学");
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_submissions WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", second.payload.reviewJob.schoolKey).first()).total, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_review_jobs WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", second.payload.reviewJob.schoolKey).first()).total, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_review_items WHERE user_id = ?")
      .bind("shared-browser-workspace").first()).total, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_review_exports WHERE user_id = ?")
      .bind("shared-browser-workspace").first()).total, 0);
    assert.equal(files.objects.has(currentSource.r2_key), false);
    assert.equal(files.objects.has(finalPayload.export.r2Key), false);

    const orphan = await upload("2026-08-03T08:00:00.000Z", "review-orphan");
    assert.equal(orphan.response.status, 201, JSON.stringify(orphan.payload));
    const orphanJob = orphan.payload.reviewJob;
    const orphanSource = await database.prepare("SELECT r2_key FROM edp_submissions WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", orphanJob.schoolKey).first();
    await database.prepare("DELETE FROM edp_submissions WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", orphanJob.schoolKey).run();
    const deleteOrphan = await callApi(worker, env, `/api/edp-reviews/${encodeURIComponent(orphanJob.jobId)}`, {
      method: "DELETE", origin: AUTH_ORIGIN, cookie,
    });
    assert.equal(deleteOrphan.status, 200, await deleteOrphan.text());
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_review_jobs WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", orphanJob.schoolKey).first()).total, 0);
    assert.equal(files.objects.has(orphanSource.r2_key), false);

    const batchOrphan = await upload("2026-08-04T08:00:00.000Z", "review-batch-orphan");
    const batchCurrent = await upload("2026-08-04T09:00:00.000Z", "review-batch-current", "北京化工大学");
    assert.equal(batchOrphan.response.status, 201, JSON.stringify(batchOrphan.payload));
    assert.equal(batchCurrent.response.status, 201, JSON.stringify(batchCurrent.payload));
    await database.prepare("DELETE FROM edp_submissions WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", batchOrphan.payload.reviewJob.schoolKey).run();
    const deleteBatch = await callApi(worker, env, "/api/edp-reviews/delete-batch", {
      method: "POST", origin: AUTH_ORIGIN, cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: [batchOrphan.payload.reviewJob.jobId, batchCurrent.payload.reviewJob.jobId] }),
    });
    const batchPayload = await deleteBatch.json();
    assert.equal(deleteBatch.status, 200, JSON.stringify(batchPayload));
    assert.equal(batchPayload.deletedCount, 2);
    assert.deepEqual(batchPayload.failures, []);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_review_jobs WHERE user_id = ?")
      .bind("shared-browser-workspace").first()).total, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS total FROM edp_submissions WHERE user_id = ?")
      .bind("shared-browser-workspace").first()).total, 0);
  } finally {
    await miniflare.dispose();
  }
});

test("EDP queue audits without downloading; exports only completed results and survives missing sources", async () => {
  const [worker, cookie] = await Promise.all([loadWorker(), authenticatedCookie()]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "edp-review-batch-export-test" },
  });
  const files = new FakeR2();
  try {
    const database = await miniflare.getD1Database("DB");
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const reviewTemplateBytes = await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url));
    env.ASSETS = {
      fetch: async (request) => new URL(request.url).pathname === "/edp-review-template-v1.xlsx"
        ? new Response(reviewTemplateBytes)
        : new Response("Not found", { status: 404 }),
    };
    assert.equal((await callApi(worker, env, "/api/edp-receipt-settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitionYear: "2026", submissionRound: 1 }),
    })).status, 200);
    assert.equal((await callApi(worker, env, "/api/edp-reviews/settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitionYear: "2026" }),
    })).status, 200);

    const upload = async (schoolName, submissionId) => {
      const form = new FormData();
      form.set("file", await makeEdpZip());
      form.set("schoolName", schoolName);
      form.set("submittedAt", `2026-08-${submissionId === "batch-1" ? "03" : "04"}T08:00:00.000Z`);
      form.set("submissionId", submissionId);
      const response = await callApi(worker, env, "/api/edp-submissions", {
        method: "POST", origin: AUTH_ORIGIN, cookie, body: form,
      });
      const payload = await response.json();
      assert.ok([200, 201].includes(response.status), JSON.stringify(payload));
      return payload.reviewJob;
    };
    const jobs = [
      await upload("中国海洋大学", "batch-1"),
      await upload("中南大学", "batch-2"),
    ];

    const post = (url, body = {}) => callApi(worker, env, url, {
      method: "POST", origin: AUTH_ORIGIN, cookie,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await post("/api/edp-reviews/export-batch", {jobIds:[jobs[0].jobId]})).status, 422);
    for (let i=0;i<2;i++) {
      const processed = await post("/api/edp-reviews/process-next");
      assert.equal(processed.status, 200, await processed.clone().text());
      assert.equal((await processed.json()).worked, true);
    }
    const idle = await post("/api/edp-reviews/process-next");
    assert.equal((await idle.json()).worked, false);
    assert.equal([...files.objects.keys()].filter(key => key.endsWith(".xlsx")).length, 0);
    const preview = await callApi(worker, env, `/api/edp-reviews/${jobs[0].jobId}`, {cookie});
    const previewBody = await preview.json();
    assert.ok(previewBody.job.reviewedAt);
    assert.ok(previewBody.items.length > 10);

    const single = await callApi(worker, env, "/api/edp-reviews/export-batch", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: [jobs[0].jobId] }),
    });
    assert.equal(single.status, 200, await single.clone().text());
    assert.match(single.headers.get("content-type") || "", /spreadsheetml\.sheet/u);
    assert.equal(single.headers.get("x-edp-review-succeeded"), "1");
    assert.equal(single.headers.get("x-edp-review-failed"), "0");
    const singleWorkbook = XLSX.read(await single.arrayBuffer(), { type: "array" });
    assert.deepEqual(singleWorkbook.SheetNames, ["1) EDP Cover Page", "2) EDP Evaluation"]);
    assert.equal(singleWorkbook.Sheets["1) EDP Cover Page"].E4.v, "中国海洋大学");

    const batch = await callApi(worker, env, "/api/edp-reviews/export-batch", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: jobs.map(({ jobId }) => jobId) }),
    });
    assert.equal(batch.status, 200, await batch.clone().text());
    assert.match(batch.headers.get("content-type") || "", /application\/zip/u);
    assert.equal(batch.headers.get("x-edp-review-succeeded"), "2");
    assert.equal(batch.headers.get("x-edp-review-failed"), "0");
    const batchZip = await JSZip.loadAsync(await batch.arrayBuffer());
    const workbooks = Object.keys(batchZip.files).filter((name) => name.endsWith(".xlsx"));
    assert.equal(workbooks.length, 2);
    assert.deepEqual(workbooks.map((name) => name.replace(/^.*?__|__草稿\.xlsx$/gu, "")).sort((a, b) => a.localeCompare(b, "zh-CN")), ["中国海洋大学", "中南大学"].sort((a, b) => a.localeCompare(b, "zh-CN")));
    assert.ok(batchZip.file("批量审核结果.txt"));

    const failedJob = jobs[1];
    const failedSource = await database.prepare("SELECT source_r2_key FROM edp_review_jobs WHERE user_id = ? AND job_id = ?")
      .bind("shared-browser-workspace", failedJob.jobId).first();
    files.objects.delete(failedSource.source_r2_key);
    // Export is independent of source parsing: completed results remain usable.
    const existingResult = await post("/api/edp-reviews/export-batch", {jobIds:[failedJob.jobId]});
    assert.equal(existingResult.status, 200);
    const queued = await post("/api/edp-reviews/enqueue", {jobIds:[failedJob.jobId]});
    assert.equal(queued.status, 202);
    const failedProcessing = await post("/api/edp-reviews/process-next");
    assert.equal((await failedProcessing.json()).failed, true);
    const partial = await callApi(worker, env, "/api/edp-reviews/export-batch", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds: jobs.map(({ jobId }) => jobId) }),
    });
    assert.equal(partial.status, 200, await partial.clone().text());
    assert.equal(partial.headers.get("x-edp-review-succeeded"), "1");
    assert.equal(partial.headers.get("x-edp-review-failed"), "1");
    const partialZip = await JSZip.loadAsync(await partial.arrayBuffer());
    assert.equal(Object.keys(partialZip.files).filter((name) => name.endsWith(".xlsx")).length, 1);
    assert.match(await partialZip.file("批量审核结果.txt").async("text"), /中南大学.*审核尚未完成/u);
    // A killed runtime cannot leave a permanent "正在审核" record.
    await database.prepare("UPDATE edp_review_jobs SET status='processing', updated_at='2020-01-01T00:00:00.000Z' WHERE job_id=?").bind(failedJob.jobId).run();
    await post("/api/edp-reviews/process-next");
    const recovered = await database.prepare("SELECT status,last_error FROM edp_review_jobs WHERE job_id=?").bind(failedJob.jobId).first();
    assert.equal(recovered.status, "failed");
    assert.match(recovered.last_error, /中断|超时/u);
  } finally {
    await miniflare.dispose();
  }
});

test("EDP review workbook preserves both styled sheets while replacing every example value", async () => {
  const { buildEdpReviewWorkbook, reviewStatusLabel } = await loadEdpReviewWorkbook();
  const templateBytes = await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url));
  assert.equal(reviewStatusLabel("yes"), "是");
  assert.equal(reviewStatusLabel("no"), "否");
  assert.equal(reviewStatusLabel("not_applicable"), "不适用");
  assert.equal(reviewStatusLabel("needs_human"), "待人工确认");
  const generated = await buildEdpReviewWorkbook(templateBytes, {
    schoolName: "测试大学（分校区）",
    competitionYear: "2027",
    submissionRound: 2,
    reviewedAt: "2026-09-01T08:30:00.000Z",
    overallStatus: "failed",
    safetyReviewerName: "安全审核员",
    safetyReviewerEmail: "safety@example.edu.cn",
    expertMemberName: "专家组成员",
    items: [
      { ruleId: "chemical_sds", row: 5, status: "no", comment: "明确发现使用含铅电池。" },
      { ruleId: "ppe", row: 6, status: "needs_human", comment: "图片清晰度不足，请人工核对 PPE。" },
    ],
  });
  const workbook = XLSX.read(generated, { type: "array", cellDates: true });
  assert.deepEqual(workbook.SheetNames, ["1) EDP Cover Page", "2) EDP Evaluation"]);
  const cover = workbook.Sheets["1) EDP Cover Page"];
  const evaluation = workbook.Sheets["2) EDP Evaluation"];
  assert.equal(cover.A1.v, "2027中国大学生Chem-E-Car竞赛®");
  assert.equal(cover.E4.v, "测试大学（分校区）");
  assert.equal(cover.E5?.v ?? "", "", "the template's example work name must be cleared");
  assert.equal(cover.E6?.v ?? "", "", "the template's example instructor must be cleared");
  assert.equal(cover.E7?.v ?? "", "", "the template's example instructor email must be cleared");
  assert.equal(cover.E8.v, "安全审核员");
  assert.equal(cover.E9.v, "safety@example.edu.cn");
  assert.equal(cover.E10.v, "专家组成员");
  assert.equal(cover.E11?.v ?? "", "");
  assert.match(cover.C13.v, /第2次 EDP 审核：未通过/u);
  assert.equal(evaluation.B5.v, "否");
  assert.equal(evaluation.D5.v, "明确发现使用含铅电池。");
  assert.equal(evaluation.B6.v, "待人工确认");
  assert.equal(evaluation.D6.v, "图片清晰度不足，请人工核对 PPE。");
  assert.equal(cover.C27.v.toISOString().slice(0, 10), "2026-09-01");

  const archive = await JSZip.loadAsync(generated);
  const coverXml = await archive.file("xl/worksheets/sheet1.xml").async("text");
  const evaluationXml = await archive.file("xl/worksheets/sheet2.xml").async("text");
  for (const merge of ["A1:E1", "C13:E13", "K13:M13", "D23:E24"]) assert.match(coverXml, new RegExp(`mergeCell ref="${merge}"`, "u"));
  for (const merge of ["A1:D1", "A17:C17", "A42:C42"]) assert.match(evaluationXml, new RegExp(`mergeCell ref="${merge}"`, "u"));
});

test("first-round EDP workbook always marks MOC not applicable even when a legacy item says missing", async () => {
  const { buildEdpReviewWorkbook } = await loadEdpReviewWorkbook();
  const templateBytes = await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url));
  const generated = await buildEdpReviewWorkbook(templateBytes, {
    schoolName: "测试大学",
    competitionYear: "2026",
    submissionRound: 1,
    reviewedAt: "2026-09-09T08:00:00.000Z",
    overallStatus: "passed",
    safetyReviewerName: "审核员",
    safetyReviewerEmail: "",
    expertMemberName: "",
    items: [{
      ruleId: "moc",
      worksheetName: "2) EDP Evaluation",
      row: 34,
      status: "no",
      comment: "MOC 内容为空或未填写变更内容及影响/风险分析。",
    }],
  });
  const workbook = XLSX.read(generated, { type: "array" });
  const cover = workbook.Sheets["1) EDP Cover Page"];
  const evaluation = workbook.Sheets["2) EDP Evaluation"];
  assert.equal(cover.C22.v, "不适用");
  assert.match(cover.D22.v, /第1次.*不要求 MOC/u);
  assert.equal(evaluation.B34.v, "不适用");
  assert.match(evaluation.D34.v, /第1次.*不要求 MOC/u);
});

test("EDP workbook writes annual detailed audit into exactly two worksheets", async () => {
  const { buildEdpReviewWorkbook } = await loadEdpReviewWorkbook();
  const templateBytes = await readFile(new URL("../public/edp-review-template-v1.xlsx", import.meta.url));
  const generated = await buildEdpReviewWorkbook(templateBytes, {
    schoolName: "天津大学",
    competitionYear: "2026",
    submissionRound: 1,
    reviewedAt: "2026-09-03T09:00:00.000Z",
    overallStatus: "needs_human",
    safetyReviewerName: "审核员",
    safetyReviewerEmail: "",
    expertMemberName: "",
    ruleFilename: "附件3-2026中国大学生Chem-E-Car竞赛®规则.pdf",
    ruleVersion: "2026-0123456789abcdef-v1",
    items: [
      {
        ruleId: "cover_required_fields",
        worksheetName: "1) EDP Cover Page",
        row: 13,
        status: "no",
        comment: "中文版封面缺少队长邮箱。",
        evidence: [{ documentRole: "chinese_edp", filename: "天津大学中文版EDP.pdf", page: 1, excerpt: "队长邮箱：" }],
      },
      {
        ruleId: "power_equation_logic",
        worksheetName: "2) EDP Evaluation",
        row: 10,
        status: "no",
        comment: "动力来源缺少定量操作条件。",
        evidence: [{ documentRole: "chinese_edp", filename: "天津大学中文版EDP.pdf", page: 2, excerpt: "动力来源：锌与盐酸反应。" }],
      },
      {
        ruleId: "control_equation_logic",
        worksheetName: "2) EDP Evaluation",
        row: 10,
        status: "needs_human",
        comment: "控制机理需人工确认。",
        evidence: [{ documentRole: "chinese_edp", filename: "天津大学中文版EDP.pdf", page: 3, excerpt: "控制机制：颜色变化后停止。" }],
      },
    ],
  });
  const workbook = XLSX.read(generated, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["1) EDP Cover Page", "2) EDP Evaluation"]);
  const cover = workbook.Sheets["1) EDP Cover Page"];
  const evaluation = workbook.Sheets["2) EDP Evaluation"];
  assert.match(cover.D16.v, /附件3-2026.*2026-0123456789abcdef-v1/u);
  assert.match(cover.D16.v, /封面缺少队长邮箱.*第1页/u);
  assert.equal(evaluation.B10.v, "否", "a definite failure must remain visible when another item on the row needs confirmation");
  assert.match(evaluation.D10.v, /动力来源缺少定量操作条件.*第2页/u);
  assert.match(evaluation.D10.v, /控制机理需人工确认.*第3页/u);
  assert.ok(evaluation.D10.v.indexOf("第2页") < evaluation.D10.v.indexOf("第3页"), "same-row comments must be ordered by evidence page");

  const archive = await JSZip.loadAsync(generated);
  assert.equal(Object.keys(archive.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).length, 2);
  const coverXml = await archive.file("xl/worksheets/sheet1.xml").async("text");
  assert.match(coverXml, /mergeCell ref="C13:E13"/u, "existing cover merge ranges must survive detailed comments");
});

test("keeps campus identities separate while trimming department suffixes", async () => {
  const { inferSchoolNameFromFilename, normalizeCompetitionSchoolName, preferDetailedCompetitionSchoolName } = await loadFileMetadata();
  const petroleumSchools = [
    normalizeCompetitionSchoolName("中国石油大学（北京）"),
    normalizeCompetitionSchoolName("中国石油大学（北京）克拉玛依校区"),
    normalizeCompetitionSchoolName("中国石油大学（华东）"),
  ];
  assert.deepEqual(petroleumSchools, [
    "中国石油大学（北京）",
    "中国石油大学（北京）克拉玛依校区",
    "中国石油大学（华东）",
  ]);
  assert.equal(new Set(petroleumSchools).size, 3);
  assert.equal(normalizeCompetitionSchoolName("大连理工大学"), "大连理工大学");
  assert.equal(normalizeCompetitionSchoolName("大连理工大学（盘锦校区）"), "大连理工大学（盘锦校区）");
  assert.equal(normalizeCompetitionSchoolName("哈尔滨工业大学（威海校区）"), "哈尔滨工业大学（威海校区）");
  assert.equal(normalizeCompetitionSchoolName("中国地质大学（武汉）"), "中国地质大学（武汉）");
  assert.equal(normalizeCompetitionSchoolName("合肥工业大学化学化工学院"), "合肥工业大学");
  assert.equal(
    preferDetailedCompetitionSchoolName("中国石油大学", ["中国石油大学（北京）-报名表"]),
    "中国石油大学（北京）",
  );
  assert.equal(
    inferSchoolNameFromFilename("中国石油大学（北京）克拉玛依校区——报名表.xlsx"),
    "中国石油大学（北京）克拉玛依校区",
  );
});

test("rejects anonymous business APIs and ignores forged OpenAI identity headers", async () => {
  const worker = await loadWorker();
  const env = await makeAuthEnv();
  const forgedHeaders = [
    {},
    { "oai-authenticated-user-email": "attacker@example.test" },
    { "oai-authenticated-user-id": "forged-user-id" },
    {
      "oai-authenticated-user-email": "attacker@example.test",
      "oai-authenticated-user-id": "forged-user-id",
    },
  ];

  for (const headers of forgedHeaders) {
    const response = await callApi(worker, env, "/api/dashboard", { headers });
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.error.code, "authentication_required");
  }

  for (const path of [
    "/api/media/poster?schoolName=x&submittedAt=2026-01-01T00%3A00%3A00.000Z&submissionId=1",
    "/api/mail-settings",
    "/api/mail-test",
    "/api/mail-sync",
    "/api/edp-receipt-settings",
    `/api/mail-media-candidates/${"a".repeat(64)}/assign`,
    "/api/media-settings/poster",
    "/api/media/poster/multipart/create",
  ]) {
    const response = await callApi(worker, env, path, {
      method: path === "/api/mail-settings" || path === "/api/media-settings/poster" || path === "/api/edp-receipt-settings" ? "PUT" : "POST",
      origin: AUTH_ORIGIN,
    });
    assert.equal(response.status, 401, `${path} must reject an anonymous write before reading its body`);
    assert.equal((await response.json()).error.code, "authentication_required");
  }

  for (const path of [
    "/api/master/download",
    "/api/mail-messages",
    "/api/mail-media-candidates",
    `/api/registrations/${encodeURIComponent("华东理工大学")}/download`,
    `/api/edp-submissions/${encodeURIComponent("华东理工大学")}/download`,
    `/api/media/poster/${encodeURIComponent("天津大学")}/download`,
    "/api/mail-attachments/0123456789abcdef0123456789abcdef/123/1/0/download",
    "/api/mail-messages/0123456789abcdef0123456789abcdef/123/1/download",
  ]) {
    const response = await callApi(worker, env, path);
    assert.equal(response.status, 401, `${path} must reject an anonymous download`);
    assert.equal((await response.json()).error.code, "authentication_required");
  }

  assert.equal(env.DB.queryLog.length, 0, "unauthenticated requests must be rejected before D1 business queries");
});

test("logs in with the configured PBKDF2 hash and exposes one shared browser workspace", async () => {
  const worker = await loadWorker();
  const env = await makeAuthEnv();

  const anonymousStatus = await callApi(worker, env, "/api/auth/status");
  assert.equal(anonymousStatus.status, 200);
  assert.deepEqual(
    { authenticated: (await anonymousStatus.json()).authenticated, configured: true },
    { authenticated: false, configured: true },
  );

  const login = await loginRequest(worker, env, TEST_PASSWORD);
  assert.equal(login.status, 200);
  const loginPayload = await login.json();
  assert.equal(loginPayload.authenticated, true);
  assert.equal(loginPayload.configured, true);
  assert.ok(Date.parse(loginPayload.expiresAt) > Date.now());

  const setCookie = login.headers.get("Set-Cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /^__Host-chemecar_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
  assert.match(setCookie, /(?:^|; )Path=\/(?:;|$)/);
  assert.match(setCookie, /(?:^|; )HttpOnly(?:;|$)/);
  assert.match(setCookie, /(?:^|; )Secure(?:;|$)/);
  assert.match(setCookie, /(?:^|; )SameSite=Strict(?:;|$)/);
  assert.match(setCookie, /(?:^|; )Max-Age=43200(?:;|$)/);
  const cookie = setCookie.split(";", 1)[0];

  const authenticatedStatus = await callApi(worker, env, "/api/auth/status", { cookie });
  assert.equal(authenticatedStatus.status, 200);
  assert.equal((await authenticatedStatus.json()).authenticated, true);

  const dashboard = await callApi(worker, env, "/api/dashboard", { cookie });
  assert.equal(dashboard.status, 200);
  const dashboardPayload = await dashboard.json();
  assert.equal(dashboardPayload.ok, true);
  assert.ok(dashboardPayload.settings);
  assert.ok(env.DB.queryLog.some(({ values }) => values.includes("shared-browser-workspace")));

  const [workerSource, schema, migration] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_app_password_auth.sql", import.meta.url), "utf8"),
  ]);
  assert.match(workerSource, /const SHARED_USER_ID = "shared-browser-workspace"/);
  assert.match(workerSource, /const PRODUCTION_SESSION_COOKIE = "__Host-chemecar_session"/);
  assert.match(schema, /export const authLoginAttempts/);
  assert.match(migration, /CREATE TABLE `auth_login_attempts`/);
});

test("rejects wrong, tampered, and expired credentials and clears the cookie on logout", async () => {
  const worker = await loadWorker();

  const wrongEnv = await makeAuthEnv();
  const wrong = await loginRequest(worker, wrongEnv, "wrong password");
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, "invalid_credentials");
  assert.equal(wrong.headers.get("Set-Cookie"), null, "a failed login must not issue or clear a session cookie");

  const env = await makeAuthEnv();
  const login = await loginRequest(worker, env, TEST_PASSWORD);
  const setCookie = login.headers.get("Set-Cookie");
  assert.ok(setCookie);
  const cookie = setCookie.split(";", 1)[0];
  const separator = cookie.indexOf("=");
  const cookieName = cookie.slice(0, separator);
  const token = cookie.slice(separator + 1);
  const signatureStart = token.indexOf(".") + 1;
  const replacement = token[signatureStart] === "A" ? "B" : "A";
  const tamperedCookie = `${cookieName}=${token.slice(0, signatureStart)}${replacement}${token.slice(signatureStart + 1)}`;
  const tampered = await callApi(worker, env, "/api/dashboard", { cookie: tamperedCookie });
  assert.equal(tampered.status, 401);
  assert.equal((await tampered.json()).error.code, "authentication_required");

  const now = Math.floor(Date.now() / 1000);
  const expiredToken = await signedSessionToken(TEST_SESSION_SECRET, {
    issuedAt: now - 7200,
    expiresAt: now - 3600,
  });
  const expired = await callApi(worker, env, "/api/dashboard", {
    cookie: `__Host-chemecar_session=${expiredToken}`,
  });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, "authentication_required");

  const logout = await callApi(worker, env, "/api/auth/logout", {
    method: "POST",
    origin: AUTH_ORIGIN,
    cookie,
  });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).authenticated, false);
  const clearedCookie = logout.headers.get("Set-Cookie");
  assert.ok(clearedCookie);
  assert.match(clearedCookie, /^__Host-chemecar_session=;/);
  assert.match(clearedCookie, /(?:^|; )Max-Age=0(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )Expires=Thu, 01 Jan 1970 00:00:00 GMT(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )HttpOnly(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )Secure(?:;|$)/);
  assert.match(clearedCookie, /(?:^|; )SameSite=Strict(?:;|$)/);

  const noOriginLogin = await loginRequest(worker, await makeAuthEnv(), TEST_PASSWORD, { withoutOrigin: true });
  assert.equal(noOriginLogin.status, 403);
  const noOriginLogout = await callApi(worker, env, "/api/auth/logout", { method: "POST", cookie });
  assert.equal(noOriginLogout.status, 403);
});

test("never delays or locks ordinary login after repeated wrong passwords", async () => {
  const worker = await loadWorker();
  const env = await makeAuthEnv();

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await loginRequest(worker, env, `wrong-${attempt}`, { ip: "198.51.100.77" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "invalid_credentials");
    assert.equal(response.headers.get("Retry-After"), null);
  }

  const immediateRetry = await loginRequest(worker, env, TEST_PASSWORD, { ip: "198.51.100.77" });
  assert.equal(immediateRetry.status, 200);
  assert.equal((await immediateRetry.json()).authenticated, true);
  assert.equal(immediateRetry.headers.get("Retry-After"), null);
});

test("keeps production PBKDF2 within the Workerd 100000-iteration boundary", async () => {
  const migrationFiles = [
    "0000_registration_collector.sql",
    "0001_edp_collector.sql",
    "0002_app_password_auth.sql",
    "0003_shared_media.sql",
    "0004_alibaba_mail_collector.sql",
    "0005_founder_shared_password.sql",
    "0006_mail_media_candidates.sql",
    "0007_media_archives_schedules.sql",
    "0017_edp_submission_archive_metadata.sql",
  ];
  const [workerSource, migrations] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    Promise.all(migrationFiles.map((filename) => readFile(new URL(`../drizzle/${filename}`, import.meta.url), "utf8"))),
  ]);
  assert.match(workerSource, /const PASSWORD_HASH_ITERATIONS = 100_000/);
  assert.match(workerSource, /iterations !== PASSWORD_HASH_ITERATIONS/);
  assert.match(workerSource, /derivePasswordHash\(password, salt, PASSWORD_HASH_ITERATIONS\)/);
  assert.doesNotMatch(workerSource, /pbkdf2-sha256\$(?:210000|310000)\$/);

  const miniflare = new Miniflare({
    modules: true,
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
    script: `
      export default {
        async fetch() {
          try {
            const key = await crypto.subtle.importKey(
              "raw",
              new TextEncoder().encode("workerd-boundary-password"),
              "PBKDF2",
              false,
              ["deriveBits"],
            );
            const bits = await crypto.subtle.deriveBits({
              name: "PBKDF2",
              hash: "SHA-256",
              salt: new TextEncoder().encode("workerd-salt-v1"),
              iterations: 100000,
            }, key, 256);
            return Response.json({ ok: true, byteLength: bits.byteLength });
          } catch (error) {
            return Response.json({ ok: false, name: error?.name, message: error?.message }, { status: 500 });
          }
        },
      };
    `,
  });
  try {
    const workerdBoundary = await miniflare.dispatchFetch("https://pbkdf2-boundary.example.test/");
    assert.equal(workerdBoundary.status, 200, "the production iteration count must execute in Workerd");
    assert.deepEqual(await workerdBoundary.json(), { ok: true, byteLength: 32 });

    const database = await miniflare.getD1Database("DB");
    for (const migration of migrations) {
      const statements = migration
        .replaceAll("--> statement-breakpoint", "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await database.prepare(statement).run();
    }

    const worker = await loadWorker();
    const founderHash = await configuredFounderPasswordHash();
    const env = await makeAuthEnv({ DB: database, APP_FOUNDER_PASSWORD_HASH: founderHash });
    const founderCodeInOrdinaryLogin = await loginRequest(worker, env, TEST_FOUNDER_PASSWORD, {
      ip: "198.51.100.201",
    });
    assert.equal(founderCodeInOrdinaryLogin.status, 401);
    assert.equal((await founderCodeInOrdinaryLogin.json()).error.code, "invalid_credentials");

    const ordinaryLogin = await loginRequest(worker, env, TEST_PASSWORD, { ip: "198.51.100.202" });
    assert.equal(ordinaryLogin.status, 200);
    const cookie = ordinaryLogin.headers.get("Set-Cookie").split(";", 1)[0];
    const wrongFounder = await founderPasswordRequest(
      worker,
      env,
      "wrong founder password",
      TEST_NEW_SHARED_PASSWORD,
      { cookie, ip: "198.51.100.203" },
    );
    assert.equal(wrongFounder.status, 401);
    assert.equal((await wrongFounder.json()).error.code, "invalid_founder_credentials");

    const overLimitHash = (await configuredPasswordHash()).replace("$100000$", "$100001$");
    const overLimitEnv = await makeAuthEnv({ DB: database });
    overLimitEnv.APP_ACCESS_PASSWORD_HASH = overLimitHash;
    const founderOverLimitEnv = await makeAuthEnv({ DB: database, APP_FOUNDER_PASSWORD_HASH: overLimitHash });
    const subtle = crypto.subtle;
    const originalDeriveBits = subtle.deriveBits;
    let pbkdf2Calls = 0;
    subtle.deriveBits = function countedDeriveBits(algorithm, ...args) {
      if (algorithm?.name === "PBKDF2") pbkdf2Calls += 1;
      return originalDeriveBits.call(this, algorithm, ...args);
    };
    try {
      const rejectedOrdinaryHash = await loginRequest(worker, overLimitEnv, TEST_PASSWORD, {
        ip: "198.51.100.204",
      });
      assert.equal(rejectedOrdinaryHash.status, 503);
      assert.equal((await rejectedOrdinaryHash.json()).error.code, "auth_not_configured");

      const rejectedFounderHash = await founderPasswordRequest(
        worker,
        founderOverLimitEnv,
        TEST_FOUNDER_PASSWORD,
        TEST_NEW_SHARED_PASSWORD,
        { cookie, ip: "198.51.100.205" },
      );
      assert.equal(rejectedFounderHash.status, 503);
      assert.equal((await rejectedFounderHash.json()).error.code, "founder_management_disabled");

      const explicitInvalidLocalEnv = await makeAuthEnv();
      explicitInvalidLocalEnv.APP_ACCESS_PASSWORD_HASH = overLimitHash;
      const rejectedLocalOverride = await worker.fetch(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: {
            Origin: "http://localhost",
            "Content-Type": "application/json",
            "CF-Connecting-IP": "127.0.0.1",
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        explicitInvalidLocalEnv,
        { waitUntil() {}, passThroughOnException() {} },
      );
      assert.equal(rejectedLocalOverride.status, 503, "an explicit invalid local hash must not fall back to preview credentials");
      assert.equal((await rejectedLocalOverride.json()).error.code, "auth_not_configured");
      assert.equal(pbkdf2Calls, 0, "a hash above the production boundary must never reach PBKDF2");
    } finally {
      subtle.deriveBits = originalDeriveBits;
    }
  } finally {
    await miniflare.dispose();
  }
});

test("gates founder password management behind origin, an ordinary session, and server configuration", async () => {
  const worker = await loadWorker();
  const envWithoutFounder = await makeAuthEnv();
  const login = await loginRequest(worker, envWithoutFounder, TEST_PASSWORD);
  assert.equal(login.status, 200, "ordinary production login must remain available without a founder hash");
  const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
  const dashboard = await callApi(worker, envWithoutFounder, "/api/dashboard", { cookie });
  assert.equal(dashboard.status, 200);
  const status = await callApi(worker, envWithoutFounder, "/api/auth/status", { cookie });
  assert.equal((await status.json()).founderManagementEnabled, false);

  const disabled = await founderPasswordRequest(
    worker,
    envWithoutFounder,
    TEST_FOUNDER_PASSWORD,
    TEST_NEW_SHARED_PASSWORD,
    { cookie },
  );
  assert.equal(disabled.status, 503);
  const disabledText = await disabled.text();
  assert.equal(JSON.parse(disabledText).error.code, "founder_management_disabled");
  assert.doesNotMatch(disabledText, /pbkdf2|Founder-only|New shared/i);

  const founderHash = await configuredFounderPasswordHash();
  const protectedEnv = await makeAuthEnv({ APP_FOUNDER_PASSWORD_HASH: founderHash });
  const protectedCookie = await authenticatedCookie();
  const noOrigin = await founderPasswordRequest(
    worker,
    protectedEnv,
    TEST_FOUNDER_PASSWORD,
    TEST_NEW_SHARED_PASSWORD,
    { cookie: protectedCookie, withoutOrigin: true },
  );
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error.code, "origin_required");

  const forgedOai = await founderPasswordRequest(
    worker,
    protectedEnv,
    TEST_FOUNDER_PASSWORD,
    TEST_NEW_SHARED_PASSWORD,
    { headers: { "oai-authenticated-user-email": "founder@example.test", "oai-authenticated-user-id": "forged-founder" } },
  );
  assert.equal(forgedOai.status, 401);
  assert.equal((await forgedOai.json()).error.code, "authentication_required");

  for (const weakPassword of ["TooShort1!", "letterslettersletters"]) {
    const weak = await founderPasswordRequest(
      worker,
      protectedEnv,
      TEST_FOUNDER_PASSWORD,
      weakPassword,
      { cookie: protectedCookie, ip: `198.51.100.${weakPassword.length}` },
    );
    assert.equal(weak.status, 400);
    assert.equal((await weak.json()).error.code, "new_password_policy_failed");
  }
  assert.equal(protectedEnv.DB.appSecuritySettings, null, "policy failures must not write a password override");
});

test("never delays or locks founder password verification after repeated mistakes", async () => {
  const worker = await loadWorker();
  const env = await makeAuthEnv({ APP_FOUNDER_PASSWORD_HASH: await configuredFounderPasswordHash() });
  const cookie = await authenticatedCookie();

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await founderPasswordRequest(worker, env, `wrong-founder-${attempt}`, TEST_NEW_SHARED_PASSWORD, {
      cookie,
      ip: "198.51.100.88",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "invalid_founder_credentials");
    assert.equal(response.headers.get("Retry-After"), null);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }

  const immediateRetry = await founderPasswordRequest(worker, env, TEST_FOUNDER_PASSWORD, TEST_NEW_SHARED_PASSWORD, {
    cookie,
    ip: "198.51.100.88",
  });
  assert.equal(immediateRetry.status, 200);
  assert.equal((await immediateRetry.json()).authenticated, true);
  assert.equal(immediateRetry.headers.get("Retry-After"), null);
  assert.ok(immediateRetry.headers.get("Set-Cookie")?.includes("HttpOnly"));
  assert.ok(env.DB.appSecuritySettings, "a correct founder password must still work immediately after repeated mistakes");
});

test("rotates the shared password, version-invalidates old cookies, and returns only a fresh secure cookie", async () => {
  const worker = await loadWorker();
  const database = new FakeD1();
  const env = await makeAuthEnv({
    DB: database,
    APP_FOUNDER_PASSWORD_HASH: await configuredFounderPasswordHash(),
  });
  const initialLogin = await loginRequest(worker, env, TEST_PASSWORD, { ip: "203.0.113.41" });
  assert.equal(initialLogin.status, 200);
  const oldCookie = initialLogin.headers.get("Set-Cookie").split(";", 1)[0];

  const changed = await founderPasswordRequest(
    worker,
    env,
    TEST_FOUNDER_PASSWORD,
    TEST_NEW_SHARED_PASSWORD,
    { cookie: oldCookie, ip: "203.0.113.42" },
  );
  assert.equal(changed.status, 200);
  const changedText = await changed.text();
  const changedPayload = JSON.parse(changedText);
  assert.equal(changedPayload.changed, true);
  assert.equal(changedPayload.authenticated, true);
  assert.equal(changedPayload.passwordVersion, 2);
  assert.doesNotMatch(changedText, /pbkdf2|shared_password_hash|Founder-only|New shared/i);
  const setCookie = changed.headers.get("Set-Cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /^__Host-chemecar_session=/);
  assert.match(setCookie, /(?:^|; )HttpOnly(?:;|$)/);
  assert.match(setCookie, /(?:^|; )Secure(?:;|$)/);
  assert.match(setCookie, /(?:^|; )SameSite=Strict(?:;|$)/);
  const newCookie = setCookie.split(";", 1)[0];
  const newToken = newCookie.slice(newCookie.indexOf("=") + 1);
  const newSessionPayload = JSON.parse(Buffer.from(newToken.split(".", 1)[0], "base64url").toString("utf8"));
  assert.equal(newSessionPayload.pv, 2);

  assert.equal(database.appSecuritySettings.password_version, 2);
  assert.match(database.appSecuritySettings.shared_password_hash, /^pbkdf2-sha256\$100000\$/);
  assert.notEqual(database.appSecuritySettings.shared_password_hash, await configuredPasswordHash());
  assert.ok(database.queryLog.every(({ values }) => !values.includes(TEST_FOUNDER_PASSWORD) && !values.includes(TEST_NEW_SHARED_PASSWORD)));

  const staleDashboard = await callApi(worker, env, "/api/dashboard", { cookie: oldCookie });
  assert.equal(staleDashboard.status, 401);
  assert.equal((await staleDashboard.json()).error.code, "authentication_required");
  const freshDashboard = await callApi(worker, env, "/api/dashboard", { cookie: newCookie });
  assert.equal(freshDashboard.status, 200);
  const freshStatus = await callApi(worker, env, "/api/auth/status", { cookie: newCookie });
  const freshStatusPayload = await freshStatus.json();
  assert.deepEqual(
    { authenticated: freshStatusPayload.authenticated, passwordVersion: freshStatusPayload.passwordVersion },
    { authenticated: true, passwordVersion: 2 },
  );

  const oldPasswordLogin = await loginRequest(worker, env, TEST_PASSWORD, { ip: "203.0.113.43" });
  assert.equal(oldPasswordLogin.status, 401);
  assert.equal(oldPasswordLogin.headers.get("Set-Cookie"), null);
  const newPasswordLogin = await loginRequest(worker, env, TEST_NEW_SHARED_PASSWORD, { ip: "203.0.113.43" });
  assert.equal(newPasswordLogin.status, 200);
  assert.match(newPasswordLogin.headers.get("Set-Cookie"), /^__Host-chemecar_session=/);
});

test("validates media signatures and keeps one latest shared object per school", async () => {
  const worker = await loadWorker();
  const db = new FakeD1();
  const files = new FakeR2();
  const env = await makeAuthEnv({ DB: db, FILES: files });
  const jpegV1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 8, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3, 4, 5, 6]);
  const jpegV2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 6, 5, 4, 3, 2, 1]);

  const invalid = await postMedia(worker, env, {
    submittedAt: "2026-06-01T01:00:00.000Z",
    submissionId: "90",
    filename: "天津大学海报.jpg",
    bytes: new Uint8Array(16).fill(0x41),
  });
  assert.equal(invalid.response.status, 415);
  assert.equal(invalid.payload.error.code, "invalid_jpeg_header");
  assert.equal(files.putCalls.length, 0, "a renamed non-JPEG must not reach R2");

  const first = await postMedia(worker, env, {
    submittedAt: "2026-06-02T01:00:00.000Z",
    submissionId: "100",
    filename: "天津大学海报.jpg",
    bytes: jpegV1,
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.payload.accepted, true);
  assert.equal(first.payload.asset.contentType, "image/jpeg");
  assert.equal(files.putCalls.length, 1);
  assert.equal(files.objects.size, 1);

  const older = await postMedia(worker, env, {
    submittedAt: "2026-06-01T12:00:00.000Z",
    submissionId: "99",
    filename: "天津大学旧海报.jpg",
    bytes: jpegV2,
  });
  assert.equal(older.response.status, 200);
  assert.equal(older.payload.accepted, false);
  assert.equal(older.payload.reason, "older-or-equal");
  assert.equal(files.putCalls.length, 1, "an older version must not overwrite the shared object");

  const latest = await postMedia(worker, env, {
    submittedAt: "2026-06-03T01:00:00.000Z",
    submissionId: "200",
    filename: "天津大学海报第二版.jpg",
    bytes: jpegV2,
  });
  assert.equal(latest.response.status, 200);
  assert.equal(latest.payload.accepted, true);
  assert.equal(latest.payload.asset.submissionId, "200");
  assert.equal(files.putCalls.length, 2);
  assert.equal(files.putCalls[1].options.onlyIf.etagMatches, "etag-1", "structured R2 conditions must use an unquoted ETag");
  assert.equal(files.objects.size, 1, "the stable per-school key must contain only the current poster");
  assert.deepEqual([...files.objects.values()][0].bytes, jpegV2);

  const cookie = await authenticatedCookie();
  const download = await callApi(worker, env, latest.payload.asset.downloadUrl, { cookie });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("Content-Type"), "image/jpeg");
  assert.match(download.headers.get("Content-Disposition") ?? "", /filename\*=UTF-8''/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), jpegV2);

  const invalidMp4 = await postMedia(worker, env, {
    kind: "video",
    submittedAt: "2026-06-03T02:00:00.000Z",
    submissionId: "201",
    filename: "天津大学视频.mp4",
    bytes: new Uint8Array(16),
  });
  assert.equal(invalidMp4.response.status, 415);
  assert.equal(invalidMp4.payload.error.code, "invalid_mp4_header");

  const mediaSource = await readFile(new URL("../worker/media-assets.ts", import.meta.url), "utf8");
  assert.match(mediaSource, /startsWithAscii\(header, "%PDF-"\)/);
  assert.match(mediaSource, /startsWithAscii\(header, "%!PS-Adobe"\)/);
  assert.match(mediaSource, /header\[4\] === 0x66[\s\S]*header\[7\] === 0x70/);
  assert.match(mediaSource, /FixedLengthStream/);
  assert.match(mediaSource, /invalid_zip_header/);
  assert.match(mediaSource, /invalid_7z_header/);
  assert.match(mediaSource, /invalid_rar_header/);
  assert.match(mediaSource, /MAX_POSTER_BYTES = 200 \* 1024 \* 1024/);
  assert.match(mediaSource, /MAX_VIDEO_BYTES = 200 \* 1024 \* 1024/);
});

test("uploads archive media through multipart and enforces the configured start date", async () => {
  const [worker, cookie] = await Promise.all([loadWorker(), authenticatedCookie()]);
  const database = new FakeD1();
  const files = new FakeR2();
  const env = await makeAuthEnv({ DB: database, FILES: files });
    const settings = await callApi(worker, env, "/api/media-settings/poster", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsAt: "2026-08-01",
        runTime: "09:00",
        timezone: "Asia/Shanghai",
        intervalMinutes: 1440,
        enabled: false,
      }),
    });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).settings.startsAt, "2026-08-01");

    const tooEarly = await callApi(worker, env, "/api/media/poster/multipart/create", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schoolName: "北京化工大学",
        submittedAt: "2026-07-31T10:00:00.000Z",
        submissionId: "1",
        filename: "北京化工大学海报.zip",
        totalSize: 32,
      }),
    });
    assert.equal(tooEarly.status, 422);
    assert.equal((await tooEarly.json()).error.code, "before_collection_start");

    const zipBytes = new Uint8Array(32);
    zipBytes.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const create = await callApi(worker, env, "/api/media/poster/multipart/create", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schoolName: "北京化工大学",
        submittedAt: "2026-08-02T10:00:00.000Z",
        submissionId: "2",
        filename: "北京化工大学海报.zip",
        totalSize: zipBytes.byteLength,
      }),
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.equal(created.accepted, true);
    assert.equal(created.partCount, 1);

    const part = await callApi(worker, env, `/api/media/poster/multipart/${created.sessionId}/parts/1`, {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(zipBytes.byteLength),
      },
      body: zipBytes,
    });
    assert.equal(part.status, 200);
    const uploadedPart = await part.json();
    assert.equal(uploadedPart.partNumber, 1);
    assert.ok(uploadedPart.etag);

    const complete = await callApi(worker, env, `/api/media/poster/multipart/${created.sessionId}/complete`, {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ partNumber: uploadedPart.partNumber, etag: uploadedPart.etag }] }),
    });
    assert.equal(complete.status, 201);
    const completed = await complete.json();
    assert.equal(completed.accepted, true);
    assert.equal(completed.asset.contentType, "application/zip");
    assert.equal(completed.asset.size, zipBytes.byteLength);

    const download = await callApi(worker, env, completed.asset.downloadUrl, { cookie });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("Content-Type"), "application/zip");
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), zipBytes);
});

test("copies a completed multipart object through a native Workerd fixed-length stream", async () => {
  const script = `
    export default {
      async fetch(_request, env) {
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
        const upload = await env.FILES.createMultipartUpload("temporary/archive.zip");
        const part = await upload.uploadPart(1, bytes);
        await upload.complete([part]);
        const temporary = await env.FILES.get("temporary/archive.zip");
        const fixedLength = new FixedLengthStream(bytes.byteLength);
        const copy = temporary.body.pipeTo(fixedLength.writable);
        const stored = await env.FILES.put("final/archive.zip", fixedLength.readable, {
          httpMetadata: { contentType: "application/zip" },
        });
        await copy;
        const finalObject = await env.FILES.get("final/archive.zip");
        return Response.json({
          stored: Boolean(stored),
          size: finalObject?.size,
          bytes: Array.from(new Uint8Array(await finalObject.arrayBuffer())),
        });
      }
    };
  `;
  const miniflare = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-05-15",
    r2Buckets: ["FILES"],
  });
  try {
    const response = await miniflare.dispatchFetch("http://localhost/");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      stored: true,
      size: 8,
      bytes: [0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4],
    });
  } finally {
    await miniflare.dispose();
  }
});

test("archives mail media candidates into the same latest-per-school library without trusting MIME", async () => {
  const migrationFiles = [
    "0000_registration_collector.sql",
    "0001_edp_collector.sql",
    "0002_app_password_auth.sql",
    "0003_shared_media.sql",
    "0004_alibaba_mail_collector.sql",
    "0005_founder_shared_password.sql",
    "0006_mail_media_candidates.sql",
    "0007_media_archives_schedules.sql",
    "0017_edp_submission_archive_metadata.sql",
  ];
  const [migrations, mailApi, mediaSource] = await Promise.all([
    Promise.all(migrationFiles.map((filename) => readFile(new URL(`../drizzle/${filename}`, import.meta.url), "utf8"))),
    readFile(new URL("../worker/mail-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/media-assets.ts", import.meta.url), "utf8"),
  ]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const migration of migrations) {
      for (const statement of migration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
    }
    const files = new FakeR2();
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const worker = await loadWorker();
    const cookie = await authenticatedCookie();
    const userId = "shared-browser-workspace";
    const mailboxKey = "e".repeat(32);
    const jpegV1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 8, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3, 4, 5, 6]);
    const jpegV2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 6, 5, 4, 3, 2, 1]);
    let nextUid = 1;

    const seedCandidate = async ({
      id,
      filename,
      bytes,
      receivedAt,
      status = "pending",
      reason = "school_confirmation_required",
      inferredSchoolName = null,
      assignedSchoolName = null,
      lastAttemptAt = null,
    }) => {
      const uid = nextUid;
      nextUid += 1;
      const r2Key = `mail-source/${id}`;
      files.seedBytes(r2Key, bytes, { contentType: "image/jpeg" });
      await database.prepare(`
        INSERT INTO mail_attachments (
          user_id, mailbox_key, uid_validity, message_uid, attachment_index,
          filename, content_type, size, r2_key, category, collected_at
        ) VALUES (?, ?, '777', ?, 0, ?, 'image/jpeg', ?, ?, 'poster', ?)
      `).bind(userId, mailboxKey, uid, filename, bytes.byteLength, r2Key, receivedAt).run();
      await database.prepare(`
        INSERT INTO mail_media_candidates (
          user_id, candidate_id, mailbox_key, mailbox_email, uid_validity,
          message_uid, attachment_index, kind, filename, subject, sender,
          received_at, attachment_r2_key, status, reason, inferred_school_name,
          assigned_school_name, attempt_count, last_attempt_at, assigned_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'registration@example.com', '777', ?, 0, 'poster', ?, ?,
          'team@example.com', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).bind(
        userId,
        id,
        mailboxKey,
        uid,
        filename,
        `邮件附件 ${filename}`,
        receivedAt,
        r2Key,
        status,
        reason,
        inferredSchoolName,
        assignedSchoolName,
        status === "processing" ? 1 : 0,
        lastAttemptAt,
        receivedAt,
        receivedAt,
      ).run();
      return { uid, r2Key };
    };
    const assignCandidate = (id, schoolName, origin = AUTH_ORIGIN) => callApi(
      worker,
      env,
      `/api/mail-media-candidates/${id}/assign`,
      {
        method: "POST",
        origin,
        cookie,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schoolName }),
      },
    );

    const webUpload = await postMedia(worker, env, {
      schoolName: "天津大学",
      submittedAt: "2027-06-02T10:00:00.000Z",
      submissionId: "web-200",
      filename: "天津大学海报.jpg",
      bytes: jpegV1,
    });
    assert.equal(webUpload.response.status, 201);
    assert.equal(webUpload.payload.asset.source, "web");
    assert.equal(webUpload.payload.asset.sourceRef, "web:web-200");

    const olderId = "a".repeat(64);
    const olderAttachment = await seedCandidate({
      id: olderId,
      filename: "older.jpg",
      bytes: jpegV2,
      receivedAt: "2027-06-01T10:00:00.000Z",
    });
    const candidateList = await callApi(worker, env, "/api/mail-media-candidates?status=all", { cookie });
    assert.equal(candidateList.status, 200);
    const candidateText = await candidateList.text();
    const candidatePayload = JSON.parse(candidateText);
    assert.equal(candidatePayload.candidates[0].downloadUrl, `/api/mail-attachments/${mailboxKey}/777/${olderAttachment.uid}/0/download`);
    assert.doesNotMatch(candidateText, /attachment_r2_key|r2_key|mail-source\//i);

    const noOrigin = await assignCandidate(olderId, "天津大学", null);
    assert.equal(noOrigin.status, 403);
    assert.equal((await noOrigin.json()).error.code, "origin_required");
    const olderAssignment = await assignCandidate(olderId, "天津大学");
    assert.equal(olderAssignment.status, 200);
    const olderPayload = await olderAssignment.json();
    assert.equal(olderPayload.accepted, false);
    assert.equal(olderPayload.reason, "older-or-equal");
    assert.equal(olderPayload.asset.source, "web", "an older email must not replace the newer website version");

    const newerId = "b".repeat(64);
    await seedCandidate({
      id: newerId,
      filename: "天津大学邮件新版.jpg",
      bytes: jpegV2,
      receivedAt: "2027-06-03T10:00:00.000Z",
    });
    const newerAssignment = await assignCandidate(newerId, "天津大学");
    assert.equal(newerAssignment.status, 200);
    const newerPayload = await newerAssignment.json();
    assert.equal(newerPayload.accepted, true);
    assert.equal(newerPayload.asset.source, "email");
    assert.equal(newerPayload.asset.sourceRef, `mail-candidate:${newerId}`);
    const putCountAfterAssignment = files.putCalls.length;

    const idempotent = await assignCandidate(newerId, "天津大学");
    assert.equal(idempotent.status, 200);
    const idempotentPayload = await idempotent.json();
    assert.deepEqual(
      { accepted: idempotentPayload.accepted, reason: idempotentPayload.reason },
      { accepted: false, reason: "already-assigned" },
    );
    assert.equal(files.putCalls.length, putCountAfterAssignment, "same-school reassignment must not write R2 again");
    const conflictingSchool = await assignCandidate(newerId, "北京大学");
    assert.equal(conflictingSchool.status, 409);
    assert.equal((await conflictingSchool.json()).error.code, "mail_media_candidate_already_assigned");

    const invalidId = "c".repeat(64);
    await seedCandidate({
      id: invalidId,
      filename: "伪造海报.jpg",
      bytes: new Uint8Array(16).fill(0x41),
      receivedAt: "2027-06-04T10:00:00.000Z",
    });
    const putCountBeforeInvalid = files.putCalls.length;
    const invalid = await assignCandidate(invalidId, "无效大学");
    assert.equal(invalid.status, 415);
    assert.equal((await invalid.json()).error.code, "invalid_jpeg_header");
    assert.equal(files.putCalls.length, putCountBeforeInvalid, "a fake MIME/extension must fail magic-byte validation before library storage");
    const invalidRow = await database.prepare(`
      SELECT status, reason FROM mail_media_candidates WHERE user_id = ? AND candidate_id = ?
    `).bind(userId, invalidId).first();
    assert.deepEqual(invalidRow, { status: "invalid", reason: "invalid_jpeg_header" });
    const invalidAgain = await assignCandidate(invalidId, "无效大学");
    assert.equal(invalidAgain.status, 422);
    assert.equal((await invalidAgain.json()).error.code, "mail_media_candidate_invalid");

    const pendingId = "d".repeat(64);
    const automaticId = "e".repeat(64);
    const staleId = "f".repeat(64);
    await seedCandidate({
      id: pendingId,
      filename: "无法识别学校.jpg",
      bytes: jpegV1,
      receivedAt: "2027-06-05T10:00:00.000Z",
    });
    await seedCandidate({
      id: automaticId,
      filename: "自动大学.jpg",
      bytes: jpegV1,
      receivedAt: "2027-06-05T11:00:00.000Z",
      status: "retry",
      reason: "known_school_unique_match",
      inferredSchoolName: "自动大学",
    });
    await seedCandidate({
      id: staleId,
      filename: "恢复大学.jpg",
      bytes: jpegV1,
      receivedAt: "2027-06-05T12:00:00.000Z",
      status: "processing",
      reason: "media_import_in_progress",
      inferredSchoolName: "恢复大学",
      assignedSchoolName: "恢复大学",
      lastAttemptAt: "2020-01-01T00:00:00.000Z",
    });
    await worker.scheduled({}, env, { waitUntil() {} });
    const postScheduleRows = await database.prepare(`
      SELECT candidate_id, status, assigned_school_name
      FROM mail_media_candidates
      WHERE candidate_id IN (?, ?, ?)
      ORDER BY candidate_id
    `).bind(pendingId, automaticId, staleId).all();
    assert.deepEqual(postScheduleRows.results, [
      { candidate_id: pendingId, status: "pending", assigned_school_name: null },
      { candidate_id: automaticId, status: "assigned", assigned_school_name: "自动大学" },
      { candidate_id: staleId, status: "assigned", assigned_school_name: "恢复大学" },
    ]);

    const dashboard = await callApi(worker, env, "/api/dashboard", { cookie });
    assert.equal(dashboard.status, 200);
    const posterBySchool = new Map((await dashboard.json()).media.posters.map((asset) => [asset.schoolName, asset]));
    assert.equal(posterBySchool.get("天津大学").source, "email");
    assert.equal(posterBySchool.get("天津大学").sourceRef, `mail-candidate:${newerId}`);
    assert.equal(posterBySchool.get("自动大学").source, "email");
    assert.equal(posterBySchool.get("恢复大学").source, "email");
    assert.equal(posterBySchool.has("无效大学"), false);

    const putMessageBody = mailApi.slice(mailApi.indexOf("async function putMessage"), mailApi.indexOf("function candidateReasonMessage"));
    assert.match(putMessageBody, /validateMediaAssetSignature\(kind, attachmentRow\.filename, attachment\.bytes\)/);
    assert.match(putMessageBody, /INSERT INTO mail_media_candidates[\s\S]*UPDATE mail_settings[\s\S]*last_uid = \?/);
    assert.match(mailApi, /if \(known\.length === 1\) return \{ schoolName: known\[0\], reason: "known_school_unique_match" \}/);
    assert.match(mailApi, /if \(inferredSchoolName\) status = "retry"/);
    assert.match(mailApi, /status = 'retry' AND inferred_school_name IS NOT NULL/);
    assert.match(
      mailApi,
      /status = 'processing' AND assigned_school_name IS NOT NULL[\s\S]*last_attempt_at/,
    );
    assert.match(mailApi, /AND attempt_count = \?/);
    assert.match(mediaSource, /export function validateMediaAssetSignature/);
    assert.match(mailApi, /sourceRef: `mail-candidate:\$\{claimed\.candidate_id\}`/);
  } finally {
    await miniflare.dispose();
  }
});

test("encrypts shared mail credentials and never returns ciphertext or plaintext", async () => {
  const worker = await loadWorker();
  const db = new FakeD1();
  const env = await makeAuthEnv({ DB: db });
  const cookie = await authenticatedCookie();
  const securityPassword = "Aliyun-client-secret-测试";
  const settingsResponse = await callApi(worker, env, "/api/mail-settings", {
    method: "PUT",
    origin: AUTH_ORIGIN,
    cookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "Registration@Example.com",
      imapHost: "imap.qiye.aliyun.com",
      imapPort: 993,
      securityPassword,
      startsAt: "2027-06-01",
      runTime: "09:30",
      timezone: "Asia/Shanghai",
      intervalMinutes: 1440,
      enabled: true,
    }),
  });
  assert.equal(settingsResponse.status, 200);
  const settingsText = await settingsResponse.text();
  const settingsPayload = JSON.parse(settingsText);
  assert.equal(settingsPayload.settings.email, "registration@example.com");
  assert.equal(settingsPayload.settings.credentialConfigured, true);
  assert.doesNotMatch(settingsText, new RegExp(securityPassword));
  assert.doesNotMatch(settingsText, /credential[_A-Z]?ciphertext/i);

  assert.equal(db.mailSettings.user_id, "shared-browser-workspace");
  assert.match(db.mailSettings.credential_ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(db.mailSettings.credential_ciphertext, securityPassword);
  assert.equal(await decryptStoredCredential(db.mailSettings.credential_ciphertext, TEST_CREDENTIAL_KEY), securityPassword);

  const dashboard = await callApi(worker, env, "/api/dashboard", { cookie });
  assert.equal(dashboard.status, 200);
  const dashboardText = await dashboard.text();
  const dashboardPayload = JSON.parse(dashboardText);
  assert.equal(dashboardPayload.mail.settings.email, "registration@example.com");
  assert.equal(dashboardPayload.mail.settings.credentialConfigured, true);
  assert.deepEqual(dashboardPayload.mail.messages, []);
  assert.deepEqual(dashboardPayload.mail.issues, []);
  assert.doesNotMatch(dashboardText, /credential_ciphertext|Aliyun-client-secret/i);
  assert.ok(db.queryLog.some(({ values }) => values.includes("shared-browser-workspace")));
});

test("executes the production mail-settings UPSERT atomically in D1", async () => {
  const [mailApi, migration] = await Promise.all([
    readFile(new URL("../worker/mail-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_alibaba_mail_collector.sql", import.meta.url), "utf8"),
  ]);
  const upsertMatch = mailApi.match(/const savedRow = await env\.DB\.prepare\(`([\s\S]*?)`\)\.bind\(/);
  const lockMatch = mailApi.match(/async function acquireSyncLock[\s\S]*?const row = await env\.DB\.prepare\(`([\s\S]*?)`\)\.bind\(/);
  assert.ok(upsertMatch, "the settings UPSERT must be extractable from the production source");
  assert.ok(lockMatch, "the atomic lock UPDATE must be extractable from the production source");

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
  });
  try {
    const database = await miniflare.getD1Database("DB");
    await database.prepare(migration.split("--> statement-breakpoint", 1)[0].trim()).run();
    const userId = "shared-browser-workspace";
    const initialTime = "2027-06-01T00:00:00.000Z";
    const upsert = async (email, updatedAt, lockComparisonTime) => database
      .prepare(upsertMatch[1])
      .bind(
        userId,
        email,
        "imap.qiye.aliyun.com",
        993,
        "v1.test-ciphertext.test-tag",
        "2027-06-01",
        "09:30",
        "Asia/Shanghai",
        1440,
        1,
        "2027-06-01T01:30:00.000Z",
        null,
        0,
        null,
        "never",
        null,
        updatedAt,
        lockComparisonTime,
      )
      .first();

    const inserted = await upsert("first@example.com", initialTime, initialTime);
    assert.equal(inserted.user_id, userId, "SQLite/D1 must accept ON CONFLICT ... WHERE ... RETURNING");

    const lockUntil = "2027-06-01T00:15:00.000Z";
    const acquire = (token) => database
      .prepare(lockMatch[1])
      .bind(token, lockUntil, initialTime, userId, initialTime)
      .first();
    const lockResults = await Promise.all([acquire("lock-a"), acquire("lock-b")]);
    assert.equal(lockResults.filter(Boolean).length, 1, "only one concurrent UPDATE ... RETURNING may acquire the lock");
    const winningToken = lockResults.find(Boolean).sync_lock_token;

    const blocked = await upsert("blocked@example.com", "2027-06-01T00:01:00.000Z", "2027-06-01T00:01:00.000Z");
    assert.equal(blocked, null, "an active collector lock must reject a settings UPSERT without clearing the lock");
    const whileLocked = await database.prepare(`
      SELECT email, sync_lock_token, sync_lock_until FROM mail_settings WHERE user_id = ?
    `).bind(userId).first();
    assert.equal(whileLocked.email, "first@example.com");
    assert.equal(whileLocked.sync_lock_token, winningToken);
    assert.equal(whileLocked.sync_lock_until, lockUntil);

    await database.prepare("UPDATE mail_settings SET sync_lock_until = ? WHERE user_id = ?")
      .bind("2027-05-31T23:59:59.000Z", userId)
      .run();
    const afterExpiry = await upsert("latest@example.com", "2027-06-01T00:02:00.000Z", "2027-06-01T00:02:00.000Z");
    assert.equal(afterExpiry.user_id, userId);
    const updated = await database.prepare(`
      SELECT email, sync_lock_token, sync_lock_until FROM mail_settings WHERE user_id = ?
    `).bind(userId).first();
    assert.equal(updated.email, "latest@example.com");
    assert.equal(updated.sync_lock_token, null);
    assert.equal(updated.sync_lock_until, null);
  } finally {
    await miniflare.dispose();
  }
});

test("paginates complete mail history with the four-field keyset used by the dashboard", async () => {
  const migrationFiles = [
    "0000_registration_collector.sql",
    "0001_edp_collector.sql",
    "0002_app_password_auth.sql",
    "0003_shared_media.sql",
    "0004_alibaba_mail_collector.sql",
    "0005_founder_shared_password.sql",
    "0006_mail_media_candidates.sql",
    "0007_media_archives_schedules.sql",
    "0017_edp_submission_archive_metadata.sql",
  ];
  const [migrations, mailApi, dashboardSource] = await Promise.all([
    Promise.all(migrationFiles.map((filename) => readFile(new URL(`../drizzle/${filename}`, import.meta.url), "utf8"))),
    readFile(new URL("../worker/mail-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8"),
  ]);
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const migration of migrations) {
      const statements = migration
        .replaceAll("--> statement-breakpoint", "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await database.prepare(statement).run();
    }

    const userId = "shared-browser-workspace";
    const mailboxKey = "f".repeat(32);
    const collectedAt = "2027-06-01T10:00:00.000Z";
    const messageStatements = [];
    for (let index = 1; index <= 52; index += 1) {
      const uidValidity = `v${String(index).padStart(3, "0")}`;
      messageStatements.push(database.prepare(`
        INSERT INTO mail_messages (
          user_id, mailbox_key, mailbox_email, uid_validity, message_uid, message_id,
          subject, from_name, from_address, received_at, raw_r2_key, raw_size,
          attachment_count, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        userId,
        mailboxKey,
        "registration@example.com",
        uidValidity,
        100,
        `<${uidValidity}@example.com>`,
        `邮件 ${uidValidity}`,
        "参赛队",
        "team@example.com",
        collectedAt,
        `mail/${uidValidity}/message.eml`,
        128,
        index <= 2 ? 1 : 0,
        collectedAt,
      ));
    }
    await database.batch(messageStatements);
    await database.batch([1, 2].map((index) => {
      const uidValidity = `v${String(index).padStart(3, "0")}`;
      return database.prepare(`
        INSERT INTO mail_attachments (
          user_id, mailbox_key, uid_validity, message_uid, attachment_index,
          filename, content_type, size, r2_key, category, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        userId,
        mailboxKey,
        uidValidity,
        100,
        0,
        `${uidValidity}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        64,
        `mail/${uidValidity}/attachment-000`,
        "registration",
        collectedAt,
      );
    }));

    const worker = await loadWorker();
    const env = await makeAuthEnv({ DB: database });
    const cookie = await authenticatedCookie();
    const dashboard = await callApi(worker, env, "/api/dashboard", { cookie });
    assert.equal(dashboard.status, 200);
    const dashboardPayload = await dashboard.json();
    assert.equal(dashboardPayload.mail.messages.length, 50);
    assert.ok(dashboardPayload.mail.nextCursor);
    assert.equal(dashboardPayload.mail.messages[0].id, `${mailboxKey}:v052:100`);
    assert.equal(dashboardPayload.mail.messages.at(-1).id, `${mailboxKey}:v003:100`);

    const decodedCursor = JSON.parse(Buffer.from(dashboardPayload.mail.nextCursor, "base64url").toString("utf8"));
    assert.deepEqual(decodedCursor, {
      version: 1,
      collectedAt,
      messageUid: 100,
      mailboxKey,
      uidValidity: "v003",
    });
    const nextPage = await callApi(
      worker,
      env,
      `/api/mail-messages?cursor=${encodeURIComponent(dashboardPayload.mail.nextCursor)}&limit=50`,
      { cookie },
    );
    assert.equal(nextPage.status, 200);
    const nextPayload = await nextPage.json();
    assert.equal(nextPayload.nextCursor, null);
    assert.deepEqual(nextPayload.messages.map((message) => message.id), [
      `${mailboxKey}:v002:100`,
      `${mailboxKey}:v001:100`,
    ]);
    assert.deepEqual(nextPayload.messages.map((message) => message.attachments[0]?.filename), ["v002.xlsx", "v001.xlsx"]);
    const firstPageIds = new Set(dashboardPayload.mail.messages.map((message) => message.id));
    assert.ok(nextPayload.messages.every((message) => !firstPageIds.has(message.id)), "keyset pages must not overlap");

    assert.match(mailApi, /ORDER BY collected_at DESC, message_uid DESC, mailbox_key DESC, uid_validity DESC/);
    assert.match(mailApi, /collected_at < \?[\s\S]*message_uid < \?[\s\S]*mailbox_key < \?[\s\S]*uid_validity < \?/);
    assert.match(dashboardSource, /type DashboardResponse = \{/);
    assert.match(dashboardSource, /mail\?: \{/);
    assert.match(dashboardSource, /nextCursor\?: string \| null/);
    assert.match(dashboardSource, /(?:mediaCandidates|candidates)\?: MailMediaCandidate\[\]/);
    assert.match(dashboardSource, /new URLSearchParams\(\{ cursor: mailNextCursor, limit: "50" \}\)/);
    assert.match(dashboardSource, /setMailMessages\(\(current\) => appendUniqueMailMessages\(current, incoming\)\)/);
    assert.match(dashboardSource, /加载更多历史邮件/);
  } finally {
    await miniflare.dispose();
  }
});

test("commits incremental IMAP callbacks per UID and retries after permanent and transient failures", async () => {
  const { fetchAlibabaMailIncremental } = await loadMailCollector();
  const encoder = new TextEncoder();
  const goodMessage = (uid) => encoder.encode([
    `Message-ID: <${uid}@example.com>`,
    `Subject: Good UID ${uid}`,
    "From: Team <team@example.com>",
    "Date: Tue, 1 Jun 2027 10:00:00 +0800",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `message ${uid}`,
  ].join("\r\n"));
  const brokenMime = encoder.encode([
    "Message-ID: <2@example.com>",
    "Subject: Broken MIME",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=\"broken.bin\"",
    "Content-Transfer-Encoding: base64",
    "",
    "%%% invalid base64 %%%",
  ].join("\r\n"));

  const firstSocket = scriptedImapSocket({
    uids: [1, 2, 3],
    messages: new Map([[1, goodMessage(1)], [2, brokenMime]]),
  });
  const events = [];
  let persistedUid = 50;
  const first = await fetchAlibabaMailIncremental({
    email: "registration@example.com",
    password: "client-password",
    socketFactory: firstSocket.socketFactory,
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
    sinceUid: 50,
    expectedUidValidity: "old-validity",
    maxMessages: 2,
    onUidValidityReset: async (uidValidity) => {
      events.push(`reset:${uidValidity}`);
      persistedUid = 0;
    },
    onMessage: async (message, uidValidity) => {
      events.push(`message:${uidValidity}:${message.uid}`);
      persistedUid = message.uid;
    },
    onPermanentMessageError: async ({ uid, uidValidity, error }) => {
      events.push(`permanent:${uidValidity}:${uid}:${error.code}`);
      persistedUid = uid;
    },
  });
  assert.deepEqual(events, ["reset:777", "message:777:1", "permanent:777:2:MIME"]);
  assert.equal(persistedUid, 2);
  assert.deepEqual(
    { highestUid: first.highestUid, processedCount: first.processedCount, skippedCount: first.skippedCount, hasMore: first.hasMore },
    { highestUid: 2, processedCount: 1, skippedCount: 1, hasMore: true },
  );
  assert.ok(firstSocket.commands.some((command) => /UID SEARCH UID 1:\*/u.test(command)), "UIDVALIDITY reset must restart the search at UID 1");

  const nextSocket = scriptedImapSocket({ uids: [3], messages: new Map([[3, goodMessage(3)]]) });
  const next = await fetchAlibabaMailIncremental({
    email: "registration@example.com",
    password: "client-password",
    socketFactory: nextSocket.socketFactory,
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
    sinceUid: persistedUid,
    expectedUidValidity: "777",
    onMessage: async (message) => {
      persistedUid = message.uid;
    },
  });
  assert.equal(next.highestUid, 3);
  assert.equal(next.processedCount, 1);
  assert.equal(persistedUid, 3, "the run after a bad MIME message must continue at the following UID");
  assert.ok(nextSocket.commands.some((command) => /UID SEARCH UID 3:\*/u.test(command)));

  const transientSocket = scriptedImapSocket({ uids: [4], messages: new Map([[4, goodMessage(4)]]) });
  await assert.rejects(
    fetchAlibabaMailIncremental({
      email: "registration@example.com",
      password: "client-password",
      socketFactory: transientSocket.socketFactory,
      connectTimeoutMs: 1_000,
      commandTimeoutMs: 1_000,
      overallTimeoutMs: 2_000,
      sinceUid: persistedUid,
      expectedUidValidity: "777",
      onMessage: async () => {
        throw new Error("temporary commit failure");
      },
    }),
    /temporary commit failure/,
  );
  assert.equal(persistedUid, 3, "a transient callback failure must leave the failed UID uncheckpointed");

  const retrySocket = scriptedImapSocket({ uids: [4], messages: new Map([[4, goodMessage(4)]]) });
  const retried = await fetchAlibabaMailIncremental({
    email: "registration@example.com",
    password: "client-password",
    socketFactory: retrySocket.socketFactory,
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
    overallTimeoutMs: 2_000,
    sinceUid: persistedUid,
    expectedUidValidity: "777",
    onMessage: async (message) => {
      persistedUid = message.uid;
    },
  });
  assert.equal(retried.highestUid, 4);
  assert.equal(persistedUid, 4, "the next run must retry and commit the transiently failed UID");
});

test("wires the scheduled collector and checkpoints each committed or permanently skipped UID", async () => {
  const [workerSource, mailApi, collector, imapSource, vite] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/mail-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/mail-collector.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/alibaba-imap.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workerSource, /async scheduled\([^)]*env: Env[^)]*\): Promise<void> \{[\s\S]*runDueMailCollectors\(env\)[\s\S]*runDueFankeCollectors/);
  assert.match(vite, /triggers: \{ crons: \["\*\/5 \* \* \* \*"\] \}/);
  assert.match(mailApi, /WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= \?/);
  assert.match(mailApi, /const LOCK_MINUTES = 15;/);
  assert.match(mailApi, /securityPassword\.length < 1/);
  assert.match(mailApi, /UPDATE mail_settings[\s\S]*sync_lock_token = \?[\s\S]*sync_lock_until <= \?/);
  assert.match(mailApi, /const result = await env\.DB\.prepare\(`[\s\S]*?WHERE user_id = \? AND sync_lock_token = \?[\s\S]*?if \(!result\.meta\.changes\)/);
  assert.match(mailApi, /connectTimeoutMs: 30_000,[\s\S]*commandTimeoutMs: 60_000,[\s\S]*overallTimeoutMs: 120_000/);
  assert.match(mailApi, /sinceUid: row\.last_uid,[\s\S]*expectedUidValidity: row\.uid_validity/);
  assert.match(mailApi, /onUidValidityReset: \(uidValidity\) => resetUidValidityCheckpoint/);
  assert.match(mailApi, /onMessage: \(message, uidValidity\) => putMessage/);
  assert.match(mailApi, /onPermanentMessageError: \(failure\) => recordPermanentMessageIssue/);

  const putMessageBody = mailApi.slice(
    mailApi.indexOf("async function putMessage"),
    mailApi.indexOf("function issueCode"),
  );
  assert.match(putMessageBody, /INSERT INTO mail_messages[\s\S]*UPDATE mail_settings[\s\S]*SET uid_validity = \?, last_uid = \?/);
  assert.match(putMessageBody, /const results = await env\.DB\.batch\(statements\);[\s\S]*if \(!checkpoint\?\.meta\.changes\)/);
  const permanentIssueBody = mailApi.slice(
    mailApi.indexOf("async function recordPermanentMessageIssue"),
    mailApi.indexOf("async function acquireSyncLock"),
  );
  assert.match(permanentIssueBody, /INSERT INTO mail_issues[\s\S]*message_uid[\s\S]*failure\.uid/);
  assert.match(permanentIssueBody, /UPDATE mail_settings[\s\S]*last_uid = \?[\s\S]*failure\.uid/);

  assert.match(collector, /input\.expectedUidValidity !== undefined[\s\S]*input\.expectedUidValidity !== mailbox\.uidValidity/);
  assert.match(collector, /await input\.onUidValidityReset\(mailbox\.uidValidity\)/);
  assert.match(collector, /const allUids = await session\.searchUidsAfter\(sinceUid, sinceDate\)/);
  assert.match(mailApi, /sinceDate: row\.starts_at/);
  assert.match(imapSource, /UID SEARCH UID \$\{firstUid\}:\*\$\{dateCriterion\}/);
  assert.match(collector, /await input\.onMessage\(message, mailbox\.uidValidity\);[\s\S]*highestUid = uid/);
  assert.match(collector, /await input\.onPermanentMessageError\(\{ uid, uidValidity: mailbox\.uidValidity, error \}\);[\s\S]*highestUid = uid/);
  assert.match(imapSource, /return \[\.\.\.found\]\.sort\(\(left, right\) => left - right\)/);

  const worker = await loadWorker();
  const env = await makeAuthEnv();
  await worker.scheduled({}, env, { waitUntil() {} });
  assert.ok(env.DB.queryLog.some(({ kind, sql }) => kind === "all" && /FROM mail_settings[\s\S]*next_run_at <= \?/i.test(sql)));
  assert.equal(env.FILES.putCalls.length, 0, "an empty due set must not touch R2");
});

test("accepts authenticated Fanke webhooks, classifies four file libraries, and supports file-only manual upload with guarded deletion", async () => {
  const registrationMigration = await readFile(new URL("../drizzle/0000_registration_collector.sql", import.meta.url), "utf8");
  const edpMigration = await readFile(new URL("../drizzle/0001_edp_collector.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0008_fanke_collector.sql", import.meta.url), "utf8");
  const assistantMigration = await readFile(new URL("../drizzle/0009_fanke_one_click_assistant.sql", import.meta.url), "utf8");
  const categoryMigration = await readFile(new URL("../drizzle/0010_fanke_category_scans.sql", import.meta.url), "utf8");
  const receiptMigration = await readFile(new URL("../drizzle/0011_registration_receipts.sql", import.meta.url), "utf8");
  const edpReceiptMigration = await readFile(new URL("../drizzle/0012_edp_receipts.sql", import.meta.url), "utf8");
  const edpArchiveMetadataMigration = await readFile(new URL("../drizzle/0017_edp_submission_archive_metadata.sql", import.meta.url), "utf8");
  const miniflare = new Miniflare({
    modules: true,
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
    script: "export default { fetch() { return new Response('ok'); } }",
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const statement of registrationMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    for (const statement of edpMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    for (const statement of migration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    for (const statement of assistantMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    for (const statement of categoryMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    for (const statement of receiptMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    for (const statement of edpReceiptMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    for (const statement of edpArchiveMetadataMigration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    const secret = encodeBase64Url(new Uint8Array(32).fill(17));
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`chemecar-fanke-webhook-v1:${secret}`),
    ));
    const secretHash = Buffer.from(digest).toString("hex");
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO collector_settings (
      user_id, starts_at, run_time, timezone, interval_minutes, enabled, next_run_at, updated_at
    ) VALUES (?, '2026-07-01', '09:00', 'Asia/Shanghai', 1440, 0, NULL, ?)`)
      .bind("shared-browser-workspace", now).run();
    await database.prepare(`INSERT INTO fanke_connectors (
      user_id, form_id, secret_hash, secret_prefix, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .bind("shared-browser-workspace", "13", secretHash, secret.slice(0, 8), now, now).run();

    const worker = await loadWorker();
    const files = new FakeR2();
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const webhookPayload = {
      formId: "13",
      submitId: "1690",
      submitTime: 1784461923000,
      schoolName: "天津大学",
      files: [
        { fileId: "xlsx-1", name: "天津大学-报名表.xlsx", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/xlsx-1.xlsx?f=%E5%A4%A9%E6%B4%A5%E5%A4%A7%E5%AD%A6-%E6%8A%A5%E5%90%8D%E8%A1%A8.xlsx" },
        { fileId: "edp-1", name: "天津大学-EDP.zip", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/edp-1.zip?f=%E5%A4%A9%E6%B4%A5%E5%A4%A7%E5%AD%A6-EDP.zip" },
        { fileId: "poster-1", label: "海报文件", name: "天津大学.zip", size: 1234, downloadUrl: "https://download.s21i.co99.net/15465942/0/0/poster-1.zip?f=%E5%A4%A9%E6%B4%A5%E5%A4%A7%E5%AD%A6.zip" },
        { fileId: "video-1", label: "宣传视频", name: "天津大学.zip", size: 5678, downloadUrl: "https://download.s21i.co99.net/15465942/0/0/video-1.zip?f=%E5%A4%A9%E6%B4%A5%E5%A4%A7%E5%AD%A6.zip" },
      ],
    };
    const webhook = await callApi(worker, env, `/api/fanke/webhook/${secret}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });
    assert.equal(webhook.status, 202);
    assert.deepEqual(await webhook.json(), { ok: true, accepted: 4 });
    const queued = await database.prepare("SELECT kind, status, school_name, file_id, size FROM fanke_files ORDER BY kind").all();
    assert.deepEqual(queued.results.map((row) => row.kind), ["edp", "poster", "registration", "video"]);
    assert.ok(queued.results.every((row) => row.status === "pending" && row.school_name === "天津大学"));
    assert.equal(queued.results.find((row) => row.kind === "poster")?.file_id, "poster-1");
    assert.equal(queued.results.find((row) => row.kind === "poster")?.size, 1234);

    const wrongSecret = await callApi(worker, env, `/api/fanke/webhook/${"B".repeat(43)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });
    assert.equal(wrongSecret.status, 404);

    await database.prepare(`INSERT INTO edp_settings (
      user_id, starts_at, run_time, timezone, interval_minutes, enabled, next_run_at, updated_at
    ) VALUES (?, '2026-07-01', '09:00', 'Asia/Shanghai', 1440, 0, NULL, ?)`)
      .bind("shared-browser-workspace", now).run();

    const cookie = await authenticatedCookie();
    const assistantApi = (path, body) => callApi(worker, env, path, {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const firstRecords = [
      {
        submissionId: "2001",
        submittedAt: "2026-08-20T10:00:00+08:00",
        schoolName: "31北京化工大学",
        files: [
          { fileId: "bj-xlsx-1", filename: "北京化工大学-报名表.xlsx", fieldLabel: "参赛报名表", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/bj-xlsx-1.xlsx?f=%E5%8C%97%E4%BA%AC%E5%8C%96%E5%B7%A5%E5%A4%A7%E5%AD%A6-%E6%8A%A5%E5%90%8D%E8%A1%A8.xlsx" },
          { fileId: "bj-edp-1", filename: "北京化工大学.zip", fieldLabel: "EDP 工程设计包", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/bj-edp-1.zip?f=%E5%8C%97%E4%BA%AC%E5%8C%96%E5%B7%A5%E5%A4%A7%E5%AD%A6.zip" },
          { fileId: "bj-poster-1", filename: "北京化工大学.zip", fieldLabel: "海报文件", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/bj-poster-1.zip?f=%E5%8C%97%E4%BA%AC%E5%8C%96%E5%B7%A5%E5%A4%A7%E5%AD%A6.zip" },
          { fileId: "bj-video-1", filename: "北京化工大学.zip", fieldLabel: "宣传视频", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/bj-video-1.zip?f=%E5%8C%97%E4%BA%AC%E5%8C%96%E5%B7%A5%E5%A4%A7%E5%AD%A6.zip" },
          { filename: "ABUIABACGAAgfake!160x160.jpg", fieldLabel: "文件提交", downloadUrl: "https://15465942.s21i.faiusr.com/2/ABUIABACGAAgfake!160x160.jpg" },
        ],
      },
      {
        submissionId: "2002",
        submittedAt: "2026-08-21T11:00:00+08:00",
        schoolName: "华南理工大学",
        files: [
          { filename: "华南理工大学-报名表.xlsx", fieldLabel: "报名表", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/scut-xlsx-1.xlsx?f=%E5%8D%8E%E5%8D%97%E7%90%86%E5%B7%A5%E5%A4%A7%E5%AD%A6-%E6%8A%A5%E5%90%8D%E8%A1%A8.xlsx&token=first" },
        ],
      },
      {
        submissionId: "1999",
        submittedAt: "2026-06-30T19:00:09+08:00",
        schoolName: "日期范围外大学",
        files: [
          { fileId: "old-edp", filename: "日期范围外大学-EDP.zip", fieldLabel: "EDP 工程设计包", downloadUrl: "https://download.s21i.co99.net/15465942/0/0/old-edp.zip?f=%E6%97%A5%E6%9C%9F%E8%8C%83%E5%9B%B4%E5%A4%96%E5%A4%A7%E5%AD%A6-EDP.zip" },
        ],
      },
    ];

    const firstStart = await assistantApi("/api/fanke/assistant/start", { scanId: "scan-first", formId: "13", targetKind: "registration" });
    assert.equal(firstStart.status, 200);
    assert.equal((await firstStart.json()).startsAt, "2026-07-01");
    const firstBatch = await assistantApi("/api/fanke/assistant/ingest", { scanId: "scan-first", formId: "13", targetKind: "registration", records: firstRecords });
    assert.equal(firstBatch.status, 200);
    assert.deepEqual(await firstBatch.json(), {
      ok: true, scanId: "scan-first", formId: "13", targetKind: "registration", received: 3, outsideDate: 1, skippedOtherKinds: 0,
      newRecords: 2, changedRecords: 0, unchangedRecords: 0,
      queuedFiles: 2, unclassifiedFiles: 0, invalidRecords: 0,
    });
    assert.equal((await assistantApi("/api/fanke/assistant/finish", { scanId: "scan-first" })).status, 200);

    assert.equal((await assistantApi("/api/fanke/assistant/start", { scanId: "scan-same", formId: "13", targetKind: "registration" })).status, 200);
    const sameRecords = structuredClone(firstRecords);
    sameRecords[1].files[0].downloadUrl = `${sameRecords[1].files[0].downloadUrl.split("&token=")[0]}&token=refreshed`;
    const sameBatch = await assistantApi("/api/fanke/assistant/ingest", { scanId: "scan-same", formId: "13", targetKind: "registration", records: sameRecords });
    assert.equal(sameBatch.status, 200);
    const samePayload = await sameBatch.json();
    assert.equal(samePayload.unchangedRecords, 2);
    assert.equal(samePayload.queuedFiles, 0, "the second scan must not queue unchanged files again");
    assert.equal((await assistantApi("/api/fanke/assistant/finish", { scanId: "scan-same" })).status, 200);

    const changedRecords = structuredClone(firstRecords);
    changedRecords[1].files[0] = {
      fileId: "scut-xlsx-2",
      filename: "华南理工大学-报名表第二版.xlsx",
      fieldLabel: "报名表",
      downloadUrl: "https://download.s21i.co99.net/15465942/0/0/scut-xlsx-2.xlsx?f=%E5%8D%8E%E5%8D%97%E7%90%86%E5%B7%A5%E5%A4%A7%E5%AD%A6-%E6%8A%A5%E5%90%8D%E8%A1%A8%E7%AC%AC%E4%BA%8C%E7%89%88.xlsx",
    };
    changedRecords.push({
      submissionId: "2003",
      submittedAt: "2026-08-22T12:00:00+08:00",
      schoolName: "浙江大学",
      files: [{
        fileId: "zju-xlsx-1",
        filename: "浙江大学-报名表.xlsx",
        fieldLabel: "参赛报名表",
        downloadUrl: "https://download.s21i.co99.net/15465942/0/0/zju-xlsx-1.xlsx?f=%E6%B5%99%E6%B1%9F%E5%A4%A7%E5%AD%A6-%E6%8A%A5%E5%90%8D%E8%A1%A8.xlsx",
      }],
    });
    assert.equal((await assistantApi("/api/fanke/assistant/start", { scanId: "scan-delta", formId: "13", targetKind: "registration" })).status, 200);
    const deltaBatch = await assistantApi("/api/fanke/assistant/ingest", { scanId: "scan-delta", formId: "13", targetKind: "registration", records: changedRecords });
    assert.equal(deltaBatch.status, 200);
    const deltaPayload = await deltaBatch.json();
    assert.equal(deltaPayload.newRecords, 1);
    assert.equal(deltaPayload.changedRecords, 1);
    assert.equal(deltaPayload.unchangedRecords, 1);
    assert.equal(deltaPayload.queuedFiles, 2, "only the changed and newly submitted registration workbooks should be queued");
    assert.equal((await assistantApi("/api/fanke/assistant/finish", { scanId: "scan-delta" })).status, 200);

    assert.equal((await assistantApi("/api/fanke/assistant/start", { scanId: "scan-edp", formId: "13", targetKind: "edp" })).status, 200);
    const edpBatch = await assistantApi("/api/fanke/assistant/ingest", { scanId: "scan-edp", formId: "13", targetKind: "edp", records: firstRecords });
    assert.equal(edpBatch.status, 200);
    const edpPayload = await edpBatch.json();
    assert.equal(edpPayload.newRecords, 1);
    assert.equal(edpPayload.skippedOtherKinds, 1);
    assert.equal(edpPayload.queuedFiles, 1, "the EDP scan must queue only the EDP archive from a mixed record");
    assert.equal((await assistantApi("/api/fanke/assistant/finish", { scanId: "scan-edp" })).status, 200);

    const assistantQueue = await database.prepare("SELECT kind, source FROM fanke_files WHERE source = 'assistant' ORDER BY received_at, kind").all();
    assert.equal(assistantQueue.results.length, 4, "a changed submission must replace its old pending queue entry instead of downloading both versions");
    assert.deepEqual([...new Set(assistantQueue.results.map((row) => row.kind))].sort(), ["edp", "registration"]);
    const revisions = await database.prepare("SELECT form_id, submission_id, revision_number FROM fanke_assistant_submissions ORDER BY form_id, submission_id").all();
    assert.deepEqual(revisions.results, [
      { form_id: "13#edp", submission_id: "2001", revision_number: 1 },
      { form_id: "13#registration", submission_id: "2001", revision_number: 1 },
      { form_id: "13#registration", submission_id: "2002", revision_number: 2 },
      { form_id: "13#registration", submission_id: "2003", revision_number: 1 },
    ]);

    const normalizedSchool = await database.prepare("SELECT school_name FROM fanke_assistant_submissions WHERE submission_id = '2001'").first();
    assert.equal(normalizedSchool.school_name, "北京化工大学", "a row number must not be kept as part of the school name");
    const previewRows = await database.prepare("SELECT COUNT(*) AS total FROM fanke_files WHERE filename LIKE '%160x160.jpg'").first();
    assert.equal(previewRows.total, 0, "Fanke preview thumbnails must never enter the download queue");

    const campusRecords = [
      ["campus-1", "中国石油大学", "中国石油大学（北京）-报名表.xlsx"],
      ["campus-2", "中国石油大学", "中国石油大学（北京）克拉玛依校区-报名表.xlsx"],
      ["campus-3", "中国石油大学", "中国石油大学（华东）-报名表.xlsx"],
      ["campus-4", "大连理工大学", "大连理工大学（盘锦校区）-报名表.xlsx"],
      ["campus-5", "哈尔滨工业大学", "哈尔滨工业大学（威海校区）-报名表.xlsx"],
      ["campus-6", "合肥工业大学化学化工学院", "合肥工业大学-报名表.xlsx"],
    ].map(([submissionId, schoolName, filename], index) => ({
      submissionId,
      submittedAt: `2026-08-${String(23 + index).padStart(2, "0")}T10:00:00+08:00`,
      schoolName,
      files: [{
        fileId: `${submissionId}-xlsx`,
        filename,
        fieldLabel: "参赛报名表",
        downloadUrl: `https://download.s21i.co99.net/15465942/0/0/${submissionId}.xlsx?f=${encodeURIComponent(filename)}`,
      }],
    }));
    assert.equal((await assistantApi("/api/fanke/assistant/start", { scanId: "scan-campus", formId: "13", targetKind: "registration" })).status, 200);
    const campusBatch = await assistantApi("/api/fanke/assistant/ingest", {
      scanId: "scan-campus", formId: "13", targetKind: "registration", records: campusRecords,
    });
    assert.equal(campusBatch.status, 200);
    assert.equal((await campusBatch.json()).queuedFiles, 6);
    assert.equal((await assistantApi("/api/fanke/assistant/finish", { scanId: "scan-campus" })).status, 200);
    const normalizedCampuses = await database.prepare(`SELECT submission_id, school_name
      FROM fanke_assistant_submissions WHERE submission_id LIKE 'campus-%' ORDER BY submission_id`).all();
    assert.deepEqual(normalizedCampuses.results, [
      { submission_id: "campus-1", school_name: "中国石油大学（北京）" },
      { submission_id: "campus-2", school_name: "中国石油大学（北京）克拉玛依校区" },
      { submission_id: "campus-3", school_name: "中国石油大学（华东）" },
      { submission_id: "campus-4", school_name: "大连理工大学（盘锦校区）" },
      { submission_id: "campus-5", school_name: "哈尔滨工业大学（威海校区）" },
      { submission_id: "campus-6", school_name: "合肥工业大学" },
    ]);

    await database.prepare("UPDATE fanke_files SET status = 'processed'").run();

    const restoreSchool = "恢复测试大学";
    const restoreLatestUrl = `https://download.s21i.co99.net/15465942/0/0/restore-latest.xlsx?f=${encodeURIComponent(`${restoreSchool}-报名表.xlsx`)}`;
    const restoreRecords = [
      {
        submissionId: "restore-latest",
        submittedAt: "2026-08-28T15:00:00+08:00",
        schoolName: restoreSchool,
        files: [{
          fileId: "restore-latest-xlsx",
          filename: `${restoreSchool}-报名表.xlsx`,
          fieldLabel: "参赛报名表",
          downloadUrl: restoreLatestUrl,
        }],
      },
      {
        submissionId: "restore-older",
        submittedAt: "2026-08-27T15:00:00+08:00",
        schoolName: restoreSchool,
        files: [{
          fileId: "restore-older-xlsx",
          filename: `${restoreSchool}-旧版报名表.xlsx`,
          fieldLabel: "参赛报名表",
          downloadUrl: `https://download.s21i.co99.net/15465942/0/0/restore-older.xlsx?f=${encodeURIComponent(`${restoreSchool}-旧版报名表.xlsx`)}`,
        }],
      },
    ];
    const scanRestoreRecords = async (scanId) => {
      assert.equal((await assistantApi("/api/fanke/assistant/start", { scanId, formId: "13", targetKind: "registration" })).status, 200);
      const batch = await assistantApi("/api/fanke/assistant/ingest", {
        scanId, formId: "13", targetKind: "registration", records: restoreRecords,
      });
      assert.equal(batch.status, 200);
      const payload = await batch.json();
      assert.equal((await assistantApi("/api/fanke/assistant/finish", { scanId })).status, 200);
      return payload;
    };
    const restoreSeed = await scanRestoreRecords("scan-restore-seed");
    assert.equal(restoreSeed.newRecords, 2);
    assert.equal(restoreSeed.queuedFiles, 1, "only the latest submission for a missing school should enter the queue");
    const restorePending = await database.prepare(`SELECT submitted_at FROM fanke_files
      WHERE school_name = ? AND kind = 'registration' AND status = 'pending'`).bind(restoreSchool).all();
    assert.deepEqual(restorePending.results, [{ submitted_at: "2026-08-28T07:00:00.000Z" }]);

    const restoreWorkbook = registrationWorkbookBytes(restoreSchool, "Restored Team");
    const restoreOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target === restoreLatestUrl) {
        return new Response(restoreWorkbook, {
          status: 200,
          headers: {
            "Content-Length": String(restoreWorkbook.byteLength),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${restoreSchool}-报名表.xlsx`)}`,
          },
        });
      }
      return restoreOriginalFetch(input);
    };
    try {
      const initialCollection = await callApi(worker, env, "/api/fanke/collect/registration", { method: "POST", origin: AUTH_ORIGIN, cookie });
      assert.equal(initialCollection.status, 200);
      assert.equal((await initialCollection.json()).processed, 1);

      const existingScan = await scanRestoreRecords("scan-restore-existing");
      assert.equal(existingScan.unchangedRecords, 2);
      assert.equal(existingScan.queuedFiles, 0, "an existing shared file must not be downloaded again");

      const storedRestore = await database.prepare(`SELECT school_key, submitted_at, submission_id
        FROM collector_registrations WHERE school_name = ?`).bind(restoreSchool).first();
      assert.ok(storedRestore);
      const removeRestore = await callApi(worker, env, `/api/registrations/${encodeURIComponent(storedRestore.school_key)}`, {
        method: "DELETE",
        origin: AUTH_ORIGIN,
        cookie,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submittedAt: storedRestore.submitted_at, submissionId: storedRestore.submission_id }),
      });
      assert.equal(removeRestore.status, 200);
      assert.equal(await database.prepare(`SELECT school_key FROM collector_registrations WHERE school_name = ?`).bind(restoreSchool).first(), null);

      const recoveryScan = await scanRestoreRecords("scan-restore-deleted");
      assert.equal(recoveryScan.changedRecords, 1);
      assert.equal(recoveryScan.unchangedRecords, 1);
      assert.equal(recoveryScan.queuedFiles, 1, "a deleted shared file must be queued again on the next scan");
      const recoveryQueue = await database.prepare(`SELECT submitted_at, status FROM fanke_files
        WHERE school_name = ? AND kind = 'registration' AND status != 'processed'`).bind(restoreSchool).all();
      assert.deepEqual(recoveryQueue.results, [{ submitted_at: "2026-08-28T07:00:00.000Z", status: "pending" }]);

      const recoveredCollection = await callApi(worker, env, "/api/fanke/collect/registration", { method: "POST", origin: AUTH_ORIGIN, cookie });
      assert.equal(recoveredCollection.status, 200);
      assert.equal((await recoveredCollection.json()).processed, 1);
      assert.ok(await database.prepare(`SELECT school_key FROM collector_registrations WHERE school_name = ?`).bind(restoreSchool).first());
    } finally {
      globalThis.fetch = restoreOriginalFetch;
    }

    const viewQueueId = "c".repeat(64);
    const viewNow = new Date().toISOString();
    await database.prepare(`INSERT INTO fanke_files (
      user_id, queue_id, form_id, submission_id, submitted_at, school_name, file_id,
      filename, download_url, size, kind, status, source, attempt_count, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'edp', 'pending', 'assistant', 0, ?, ?)`)
      .bind(
        "shared-browser-workspace", viewQueueId, "13", "1524-r000000000001",
        "2026-07-19T13:19:05.000Z", "清华大学", "ABUIABA-GAAgg6yTzwYooIzGwQM",
        "凡科文件-ABUIABA-GAAgg6yTzwYooIzGwQM.zip",
        "https://hn14814107.jz.fkw.com/cn/view.jsp?fileID=ABUIABA-GAAgg6yTzwYooIzGwQM",
        viewNow, viewNow,
      ).run();
    const directUrl = "https://download.s21i.co99.net/15465942/0/0/ABUIABA-GAAgg6yTzwYooIzGwQM.zip?f=%E6%B8%85%E5%8D%8E%E5%A4%A7%E5%AD%A6-%E6%8A%A5%E5%90%8D%E8%A1%A8.zip&v=1776604745";
    const resolvedWorkbook = registrationWorkbookBytes("清华大学", "Tsinghua Team");
    const registrationArchive = new JSZip();
    registrationArchive.file("清华大学-报名表.xlsx", resolvedWorkbook);
    const resolvedArchive = await registrationArchive.generateAsync({ type: "uint8array" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target.includes("/view.jsp?fileID=")) {
        return new Response(`文件名称:清华大学-报名表.zip 文件大小:17.74KB 创建时间:2026-04-19 21:19:05 <a href="${directUrl.replaceAll("&", "&amp;")}">点击下载</a>`, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (target === directUrl) {
        return new Response(resolvedArchive, {
          status: 200,
          headers: {
            "Content-Length": String(resolvedArchive.byteLength),
            "Content-Disposition": "attachment; filename*=UTF-8''%E6%B8%85%E5%8D%8E%E5%A4%A7%E5%AD%A6-%E6%8A%A5%E5%90%8D%E8%A1%A8.zip",
          },
        });
      }
      return originalFetch(input);
    };
    try {
      const collected = await callApi(worker, env, "/api/fanke/collect/edp", { method: "POST", origin: AUTH_ORIGIN, cookie });
      assert.equal(collected.status, 200);
      assert.equal((await collected.json()).processed, 1, "the view.jsp metadata page must resolve to the real downloadable attachment");
    } finally {
      globalThis.fetch = originalFetch;
    }
    const resolvedRegistration = await database.prepare("SELECT school_name, filename FROM collector_registrations WHERE school_name = '清华大学'").first();
    assert.deepEqual(resolvedRegistration, { school_name: "清华大学", filename: "清华大学-报名表.xlsx" });

    const problemStatuses = ["invalid", "ignored", "invalid", "ignored", "invalid", "ignored", "invalid"];
    for (const [index, status] of problemStatuses.entries()) {
      await database.prepare(`INSERT INTO fanke_files (
        user_id, queue_id, form_id, submission_id, submitted_at, school_name, file_id,
        filename, download_url, size, kind, status, source, attempt_count, received_at, updated_at
      ) VALUES (?, ?, '13', ?, ?, '测试大学', NULL, ?, ?, NULL, 'poster', ?, 'assistant', 0, ?, ?)`)
        .bind("shared-browser-workspace", String(index + 1).repeat(64), `problem-${index}`, viewNow,
          `problem-${index}.jpg`, `https://download.s21i.co99.net/test/problem-${index}.jpg`, status, viewNow, viewNow).run();
    }
    const problemDashboard = await callApi(worker, env, "/api/dashboard", { cookie });
    assert.equal(problemDashboard.status, 200);
    const problemPayload = await problemDashboard.json();
    assert.equal(problemPayload.fanke.problemFiles.filter((file) => file.kind === "poster").length, 7, "the dashboard must return every problem, not only five");
    assert.equal(problemPayload.fanke.counts["poster:invalid"], 4);
    assert.equal(problemPayload.fanke.counts["poster:ignored"], 3);
    const cleared = await callApi(worker, env, "/api/fanke/problems/poster", { method: "DELETE", origin: AUTH_ORIGIN, cookie });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).deleted, 7);

    const masterForm = new FormData();
    masterForm.set("file", new File([masterWorkbookBytes()], "国内国际参赛队伍信息.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const masterUpload = await callApi(worker, env, "/api/master", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      body: masterForm,
    });
    assert.equal(masterUpload.status, 201);

    const blankReceiptSettings = await callApi(worker, env, "/api/registration-receipt-settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitionYear: "", qqGroup: "" }),
    });
    assert.equal(blankReceiptSettings.status, 400, "year and QQ group must be saved before a success receipt can be generated");

    const ghostRowForm = new FormData();
    ghostRowForm.set("file", new File([
      registrationWorkbookBytes("南京工业大学", "有效行测试队", { ghostLastRow: true }),
    ], "南京工业大学-报名表.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const ghostRowUpload = await callApi(worker, env, "/api/registrations", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: ghostRowForm,
    });
    const ghostRowPayload = await ghostRowUpload.json();
    assert.equal(ghostRowUpload.status, 201, JSON.stringify(ghostRowPayload));
    assert.equal(ghostRowPayload.registration.receipt.status, "qualified", "an isolated value on Excel row 1048576 is not a participant");
    assert.equal(ghostRowPayload.registration.receipt.studentCount, 5);
    assert.equal(ghostRowPayload.registration.receipt.settingsComplete, false);
    assert.equal(ghostRowPayload.registration.receipt.body, "", "success receipt stays unavailable until real year and QQ settings are saved");
    assert.ok(ghostRowPayload.registration.receipt.reasons.every((reason) => !reason.includes("1048576")));

    const receiptSettings = await callApi(worker, env, "/api/registration-receipt-settings", {
      method: "PUT",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competitionYear: "2026", qqGroup: "123456789" }),
    });
    assert.equal(receiptSettings.status, 200);
    assert.deepEqual((await receiptSettings.json()).settings, {
      competitionYear: "2026",
      qqGroup: "123456789",
      updatedAt: (await database.prepare("SELECT updated_at FROM registration_receipt_settings WHERE user_id = ?").bind("shared-browser-workspace").first()).updated_at,
    });
    const configuredReceiptDashboard = await callApi(worker, env, "/api/dashboard", { cookie });
    const configuredNanjingReceipt = (await configuredReceiptDashboard.json()).registrations.find((entry) => entry.schoolName === "南京工业大学").receipt;
    assert.equal(configuredNanjingReceipt.settingsComplete, true);
    assert.match(configuredNanjingReceipt.body, /已成功报名2026年Chem-E-Car®竞赛/u);
    assert.match(configuredNanjingReceipt.body, /搜索群号123456789加入2026年/u);

    await database.prepare(`UPDATE registration_receipts
      SET status = 'unqualified', student_count = 6, reasons_json = ?
      WHERE user_id = ? AND school_key = ?`)
      .bind(JSON.stringify([
        "表2-团队成员第1048576行缺少团队成员姓名。",
        "表2-团队成员第1048576行缺少联系电话。",
        "表2-团队成员第1048576行缺少E-mail。",
        "表2-团队成员第1048576行缺少年级。",
      ]), "shared-browser-workspace", ghostRowPayload.registration.schoolKey).run();
    const legacyGhostDashboard = await callApi(worker, env, "/api/dashboard", { cookie });
    const legacyGhostRegistration = (await legacyGhostDashboard.json()).registrations.find((entry) => entry.schoolName === "南京工业大学");
    assert.equal(legacyGhostRegistration.receipt.status, "needs_review", "old false row-1048576 receipts must never be displayed or drafted");
    assert.equal(legacyGhostRegistration.receipt.requiresReassessment, true);
    assert.deepEqual(legacyGhostRegistration.receipt.reasons, []);
    const reassessedGhost = await callApi(worker, env, `/api/registrations/${encodeURIComponent(ghostRowPayload.registration.schoolKey)}/receipt`, {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submittedAt: ghostRowPayload.registration.submittedAt,
        submissionId: ghostRowPayload.registration.submissionId,
      }),
    });
    const reassessedGhostPayload = await reassessedGhost.json();
    assert.equal(reassessedGhost.status, 200, JSON.stringify(reassessedGhostPayload));
    assert.equal(reassessedGhostPayload.registration.receipt.status, "qualified");
    assert.equal(reassessedGhostPayload.registration.receipt.studentCount, 5);
    assert.equal(reassessedGhostPayload.registration.receipt.requiresReassessment, false);
    assert.equal(reassessedGhostPayload.masterSync.status, "updated", "a newly qualified recheck must also repair the unique master workbook");

    const departmentForm = new FormData();
    departmentForm.set("file", new File(
      [registrationWorkbookBytes("合肥工业大学化学化工学院", "HFUT Team")],
      "合肥工业大学-报名表.xlsx",
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    ));
    const departmentUpload = await callApi(worker, env, "/api/registrations", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: departmentForm,
    });
    assert.equal(departmentUpload.status, 201);
    assert.equal((await departmentUpload.json()).registration.schoolName, "合肥工业大学");

    const uploadVersionedRegistration = async ({ schoolName, submittedAt, submissionId, teamName }) => {
      const versionedForm = new FormData();
      versionedForm.set("schoolName", schoolName);
      versionedForm.set("submittedAt", submittedAt);
      versionedForm.set("submissionId", submissionId);
      versionedForm.set("file", new File(
        [registrationWorkbookBytes(schoolName, teamName)],
        `${schoolName}-报名表.xlsx`,
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      ));
      const response = await callApi(worker, env, "/api/registrations", {
        method: "POST", origin: AUTH_ORIGIN, cookie, body: versionedForm,
      });
      return { response, payload: await response.json() };
    };
    const newestCampus = await uploadVersionedRegistration({
      schoolName: "大连理工大学（盘锦校区）",
      submittedAt: "2026-08-28T10:00:00+08:00",
      submissionId: "10",
      teamName: "盘锦最新版本",
    });
    assert.equal(newestCampus.response.status, 201);
    assert.equal(newestCampus.payload.accepted, true);
    const duplicateCampus = await uploadVersionedRegistration({
      schoolName: "大连理工大学（盘锦校区）",
      submittedAt: "2026-08-28T10:00:00+08:00",
      submissionId: "10",
      teamName: "盘锦最新版本",
    });
    assert.equal(duplicateCampus.response.status, 200);
    assert.equal(duplicateCampus.payload.accepted, false);
    assert.equal(duplicateCampus.payload.reason, "duplicate");
    const duplicateDashboard = await callApi(worker, env, "/api/dashboard", { cookie });
    const duplicateRows = (await duplicateDashboard.json()).registrations
      .filter((entry) => entry.schoolName === "大连理工大学（盘锦校区）");
    assert.equal(duplicateRows.length, 1);
    const olderCampus = await uploadVersionedRegistration({
      schoolName: "大连理工大学（盘锦校区）",
      submittedAt: "2026-08-27T10:00:00+08:00",
      submissionId: "999999",
      teamName: "盘锦旧版本",
    });
    assert.equal(olderCampus.response.status, 200);
    assert.equal(olderCampus.payload.accepted, false);
    assert.equal(olderCampus.payload.reason, "older-or-equal", "a larger ID must not beat a later submittedAt");
    assert.equal(olderCampus.payload.registration.submittedAt, "2026-08-28T02:00:00.000Z");
    const mainCampus = await uploadVersionedRegistration({
      schoolName: "大连理工大学",
      submittedAt: "2026-08-28T11:00:00+08:00",
      submissionId: "11",
      teamName: "大连主校区",
    });
    assert.equal(mainCampus.response.status, 201);
    const dalianRows = await database.prepare(`SELECT school_name FROM collector_registrations
      WHERE school_name LIKE '大连理工大学%' ORDER BY school_name`).all();
    assert.deepEqual(dalianRows.results.map((row) => row.school_name).sort(), ["大连理工大学", "大连理工大学（盘锦校区）"].sort());

    const form = new FormData();
    form.set("file", new File([registrationWorkbookBytes("华东理工大学", "Mag-ECUSTic Velocity")], "华东理工大学-报名表.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const manual = await callApi(worker, env, "/api/registrations", {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      body: form,
    });
    assert.equal(manual.status, 201);
    const manualPayload = await manual.json();
    assert.equal(manualPayload.registration.schoolName, "华东理工大学");
    assert.match(manualPayload.registration.submissionId, /^manual-\d+-/u);
    assert.equal(manualPayload.registration.receipt.status, "qualified");
    assert.equal(manualPayload.registration.receipt.recipientEmail, "team@example.edu.cn");
    assert.equal(manualPayload.registration.receipt.teacherCount, 1);
    assert.equal(manualPayload.registration.receipt.studentCount, 5);
    assert.match(manualPayload.registration.receipt.body, /已成功报名2026年Chem-E-Car®竞赛/);
    assert.match(manualPayload.registration.receipt.body, /搜索群号123456789加入2026年/);
    assert.equal(manualPayload.masterSync.status, "updated");
    const masterObject = [...files.objects.entries()].find(([key]) => key.endsWith("/master/current.xlsx"))?.[1];
    assert.ok(masterObject);
    const updatedMaster = XLSX.read(masterObject.bytes, { type: "array" });
    const domesticRows = XLSX.utils.sheet_to_json(updatedMaster.Sheets["国内"], { header: 1, defval: null, raw: false });
    const ecustRow = domesticRows.find((row) => row[0] === "华东理工大学");
    assert.ok(ecustRow);
    assert.deepEqual(ecustRow.slice(0, 7), [
      "华东理工大学", "Mag-ECUSTic Velocity", "team@example.edu.cn", "测试队长", "13800138000", "是", "线下",
    ]);

    const invalidForm = new FormData();
    invalidForm.set("file", new File([
      registrationWorkbookBytes("测试检查大学", "不完整队伍", { teacherCount: 6, studentCount: 4, missingStudentEmail: true }),
    ], "测试检查大学-报名表.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const invalidUpload = await callApi(worker, env, "/api/registrations", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: invalidForm,
    });
    const invalidPayload = await invalidUpload.json();
    assert.equal(invalidUpload.status, 201, `an incomplete but readable form must be retained for review: ${JSON.stringify(invalidPayload)}`);
    assert.equal(invalidPayload.registration.receipt.status, "unqualified");
    assert.equal(invalidPayload.registration.receipt.teacherCount, 6);
    assert.equal(invalidPayload.registration.receipt.studentCount, 4);
    assert.equal(invalidPayload.masterSync.status, "not-qualified");
    assert.ok(invalidPayload.registration.receipt.reasons.some((reason) => /不能超过5人/u.test(reason)));
    assert.ok(invalidPayload.registration.receipt.reasons.some((reason) => /必须不少于5人且不超过15人/u.test(reason)));
    assert.ok(invalidPayload.registration.receipt.reasons.some((reason) => /未填写邮箱/u.test(reason)));
    assert.match(invalidPayload.registration.receipt.body, /指导教师人数为6人，不能超过5人/u);
    assert.match(invalidPayload.registration.receipt.body, /学生人数为4人，必须不少于5人且不超过15人/u);
    assert.match(invalidPayload.registration.receipt.body, /未填写邮箱/u);
    assert.match(invalidPayload.registration.receipt.body, /请根据以上具体问题修改报名表/u);
    assert.doesNotMatch(invalidPayload.registration.receipt.body, /请规范指导老师和团队成员的人数，并将表1和表2补充完整/u);

    await database.prepare("DELETE FROM registration_receipts WHERE user_id = ? AND school_key = ?")
      .bind("shared-browser-workspace", manualPayload.registration.schoolKey).run();
    const legacyDashboard = await callApi(worker, env, "/api/dashboard", { cookie });
    const legacyRegistration = (await legacyDashboard.json()).registrations.find((entry) => entry.schoolName === "华东理工大学");
    assert.equal(legacyRegistration.receipt.status, "needs_review");
    const refreshedReceipt = await callApi(worker, env, `/api/registrations/${encodeURIComponent(manualPayload.registration.schoolKey)}/receipt`, {
      method: "POST",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submittedAt: manualPayload.registration.submittedAt, submissionId: manualPayload.registration.submissionId }),
    });
    assert.equal(refreshedReceipt.status, 200);
    assert.equal((await refreshedReceipt.json()).registration.receipt.status, "qualified");

    const deletion = await callApi(worker, env, `/api/registrations/${encodeURIComponent(manualPayload.registration.schoolKey)}`, {
      method: "DELETE",
      origin: AUTH_ORIGIN,
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submittedAt: manualPayload.registration.submittedAt,
        submissionId: manualPayload.registration.submissionId,
      }),
    });
    assert.equal(deletion.status, 200);
    assert.equal((await deletion.json()).deleted, true);
    assert.equal(await database.prepare("SELECT school_key FROM collector_registrations WHERE school_name = ?").bind("华东理工大学").first(), null);
    assert.equal(await database.prepare("SELECT school_key FROM registration_receipts WHERE school_name = ?").bind("华东理工大学").first(), null);
    assert.ok([...files.objects.keys()].some((key) => key.endsWith("/master/current.xlsx")), "deleting one registration must keep the unique master workbook");
    assert.ok([...files.objects.keys()].some((key) => key.endsWith("/registrations/%E5%90%88%E8%82%A5%E5%B7%A5%E4%B8%9A%E5%A4%A7%E5%AD%A6/current.xlsx")), "deleting one registration must keep another school's file");
  } finally {
    await miniflare.dispose();
  }
});

test("reusable registration ingestion preserves standalone upload semantics", async () => {
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(workerSource, /interface RegistrationIngestResult/);
  assert.match(workerSource, /async function ingestRegistrationFile\(/);
  assert.match(workerSource, /enforceStart:\s*!metadata\.manual/);
  assert.match(workerSource, /reason:\s*sameVersion \? "duplicate" : "older-or-equal"/);
  assert.match(workerSource, /reason:\s*"superseded"/);
});

test("EDP package parser uses content evidence and excludes a registration sidecar from core count", async () => {
  const { inspectEdpPackage } = await loadEdpPackage();
  const pdf = (path, status = "reliable") => ({
    originalPath: path,
    normalizedPath: path,
    displayPath: path,
    displayNameStatus: status,
    isDirectory: false,
    declaredSize: 9,
    bytes: new TextEncoder().encode("%PDF-1.4"),
  });
  const xlsxBytes = registrationWorkbookBytes("南京工业大学");
  const entries = [
    { ...pdf("南京工业大学"), isDirectory: true, declaredSize: 0, bytes: null },
    pdf("南京工业大学/南京工业大学2026中文版4.0.pdf"),
    pdf("南京工业大学/Nanjing Tech University 2026 English 4.0.pdf"),
    pdf("南京工业大学/乱码��������.pdf", "uncertain"),
    pdf("南京工业大学/MOC.pdf"),
    {
      originalPath: "南京工业大学/南京工业大学-报名表.xlsx",
      normalizedPath: "南京工业大学/南京工业大学-报名表.xlsx",
      displayPath: "南京工业大学/南京工业大学-报名表.xlsx",
      displayNameStatus: "reliable",
      isDirectory: false,
      declaredSize: xlsxBytes.byteLength,
      bytes: xlsxBytes,
    },
  ];
  const firstPages = new Map([
    ["南京工业大学/南京工业大学2026中文版4.0.pdf", "工程文件包 工作安全评估表 动力来源和控制机制"],
    ["南京工业大学/Nanjing Tech University 2026 English 4.0.pdf", "Chem-E-Car Engineering Documentation Package English EDP"],
    ["南京工业大学/乱码��������.pdf", "EDP Supplement Addendum supporting information"],
  ]);

  const result = await inspectEdpPackage(new Uint8Array([1]), "南京工业大学.7z", 2, {
    openArchive: async () => ({ format: "7z", entries }),
    extractFirstPageText: async (_bytes, path) => firstPages.get(path) || "",
  });

  assert.equal(result.qualified, true);
  assert.equal(result.archiveFormat, "7z");
  assert.equal(result.coreFileCount, 4);
  assert.equal(result.visibleFileCount, 5);
  assert.deepEqual(result.documents.map(({ role }) => role).sort(), ["chinese_edp", "english_edp", "moc", "supplement"]);
  assert.equal(result.documents.find(({ role }) => role === "supplement")?.roleEvidence, "first_page");
  assert.equal(result.registrationCandidates.length, 1);
});

test("EDP package parser enforces rounds, ambiguity and sidecar isolation", async () => {
  const { inspectEdpPackage } = await loadEdpPackage();
  const pdf = (path) => ({
    originalPath: path,
    normalizedPath: path,
    displayPath: path,
    displayNameStatus: "reliable",
    isDirectory: false,
    declaredSize: 9,
    bytes: new TextEncoder().encode("%PDF-1.4"),
  });
  const core = [pdf("大学-中文版EDP.pdf"), pdf("University-English-EDP.pdf"), pdf("大学-EDP增补文件.pdf")];
  const open = (entries, format = "zip") => async () => ({ format, entries });

  const roundOne = await inspectEdpPackage(new Uint8Array([1]), "大学.zip", 1, { openArchive: open(core) });
  assert.equal(roundOne.qualified, true);
  const roundOneWithMoc = await inspectEdpPackage(new Uint8Array([1]), "大学.zip", 1, { openArchive: open([...core, pdf("大学-MOC.pdf")]) });
  assert.equal(roundOneWithMoc.qualified, false);
  assert.ok(roundOneWithMoc.reasonCodes.includes("file_count"));

  const workbook = registrationWorkbookBytes("大学");
  const xlsx = (name) => ({
    originalPath: name,
    normalizedPath: name,
    displayPath: name,
    displayNameStatus: "reliable",
    isDirectory: false,
    declaredSize: workbook.byteLength,
    bytes: workbook,
  });
  const multipleSidecars = await inspectEdpPackage(new Uint8Array([1]), "大学.rar", 2, {
    openArchive: open([...core, pdf("大学-MOC.pdf"), xlsx("报名表1.xlsx"), xlsx("报名表2.xlsx")], "rar"),
  });
  assert.equal(multipleSidecars.qualified, true);
  assert.equal(multipleSidecars.coreFileCount, 4);
  assert.equal(multipleSidecars.registrationCandidates.length, 2);

  const ambiguous = await inspectEdpPackage(new Uint8Array([1]), "大学.zip", 2, {
    openArchive: open([pdf("中文一.pdf"), pdf("中文二.pdf"), pdf("补充.pdf"), pdf("MOC.pdf")]),
    extractFirstPageText: async () => "工程文件包 工作安全评估表",
  });
  assert.equal(ambiguous.qualified, false);
  assert.ok(ambiguous.reasonCodes.includes("classification"));

  const extra = new TextEncoder().encode("text");
  const unsupported = await inspectEdpPackage(new Uint8Array([1]), "大学.zip", 2, {
    openArchive: open([...core, pdf("大学-MOC.pdf"), {
      originalPath: "说明.txt", normalizedPath: "说明.txt", displayPath: "说明.txt", displayNameStatus: "reliable",
      isDirectory: false, declaredSize: extra.byteLength, bytes: extra,
    }]),
  });
  assert.equal(unsupported.qualified, false);
  assert.ok(unsupported.reasonCodes.includes("file_format"));
});

test("EDP collection preflight opens every PDF and reports an unreadable file even when its filename is classifiable", async () => {
  const { inspectEdpPackage } = await loadEdpPackage();
  const pdf = (path) => ({
    originalPath: path,
    normalizedPath: path,
    displayPath: path,
    displayNameStatus: "reliable",
    isDirectory: false,
    declaredSize: 9,
    bytes: new TextEncoder().encode("%PDF-1.4"),
  });
  const entries = [
    pdf("大学-中文版EDP.pdf"),
    pdf("University-English-EDP.pdf"),
    pdf("大学-EDP增补文件.pdf"),
    pdf("大学-MOC.pdf"),
  ];
  const opened = [];
  const result = await inspectEdpPackage(new Uint8Array([1]), "大学.zip", 2, {
    openArchive: async () => ({ format: "zip", entries }),
    validatePdfContents: true,
    extractFirstPageText: async (_bytes, path) => {
      opened.push(path);
      if (path.endsWith("MOC.pdf")) throw new Error("Invalid PDF structure");
      return "readable first page";
    },
  });
  assert.deepEqual(opened.sort(), entries.map(({ normalizedPath }) => normalizedPath).sort());
  assert.equal(result.qualified, false);
  assert.ok(result.reasonCodes.includes("file_format"));
  assert.match(result.reasons.join(" "), /MOC\.pdf.*无法解读/u);
});

test("Cloudflare libarchive opens nested 7z without location or Node-only globals", async () => {
  const pluginUrl = new URL("../build/libarchive-cloudflare-plugin.mjs", import.meta.url);
  pluginUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { cloudflareLibarchivePlugin } = await import(pluginUrl.href);
  const source = await readFile(new URL("../node_modules/libarchive-wasm/dist/libarchive.js", import.meta.url), "utf8");
  const transformed = cloudflareLibarchivePlugin().transform(
    source,
    "C:/project/node_modules/libarchive-wasm/dist/libarchive.js",
  );
  assert.equal(typeof transformed?.code, "string");

  const commonJsExports = {};
  const sandbox = {
    URL,
    WebAssembly,
    TextDecoder,
    TextEncoder,
    console,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    process: { versions: { node: "24.0.0" }, argv: [], type: undefined },
    require(name) { throw new Error(`Node-only require must not run in a Worker: ${name}`); },
    exports: commonJsExports,
    module: { exports: commonJsExports },
    WorkerGlobalScope: class WorkerGlobalScope {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  runInNewContext(transformed.code, sandbox, { filename: "libarchive-worker.js" });
  const factory = sandbox.module.exports.default || sandbox.exports.default;
  assert.equal(typeof factory, "function");

  const wasmBytes = await readFile(new URL("../node_modules/libarchive-wasm/dist/libarchive.wasm", import.meta.url));
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const emscriptenModule = await factory({
    instantiateWasm(imports, receiveInstance) {
      const instance = new WebAssembly.Instance(wasmModule, imports);
      receiveInstance(instance, wasmModule);
      return instance.exports;
    },
  });
  const { ArchiveReader, wrapLibarchiveWasm } = await import("libarchive-wasm");
  const archive = wrapLibarchiveWasm(emscriptenModule);
  const fixture = new Int8Array(await readFile(new URL("./fixtures/edp/nested-round2.7z", import.meta.url)));
  const reader = new ArchiveReader(archive, fixture);
  try {
    let fileCount = 0;
    for (const entry of reader.entries()) {
      if (entry.getFiletype() === "File") fileCount += 1;
    }
    assert.equal(fileCount, 4);
  } finally {
    reader.free();
  }
});

test("EDP archive reader treats ZIP, 7z and RAR as the same safe entry model", async () => {
  const { openEdpArchiveCore, sniffEdpArchiveFormat } = await loadEdpArchiveCore();
  const sevenZip = new Uint8Array(await readFile(new URL("./fixtures/edp/nested-round2.7z", import.meta.url)));
  const rar = new Uint8Array(await readFile(new URL("./fixtures/edp/nested-round2.rar", import.meta.url)));

  assert.equal(sniffEdpArchiveFormat(sevenZip, "南京工业大学.7z"), "7z");
  assert.equal(sniffEdpArchiveFormat(rar, "南京工业大学.rar"), "rar");

  for (const [bytes, filename] of [[sevenZip, "南京工业大学.7z"], [rar, "南京工业大学.rar"]]) {
    const archive = await openEdpArchiveCore(bytes, filename, { readLibarchiveEntries: readLibarchiveEntriesForTest });
    assert.equal(archive.entries.filter((entry) => !entry.isDirectory).length, 4);
    assert.ok(archive.entries.every((entry) => !entry.normalizedPath.includes("..")));
  }
});

test("EDP archive reader rejects extension spoofing, unsafe paths and encrypted archives", async () => {
  const { openEdpArchiveCore, EdpArchiveError } = await loadEdpArchiveCore();
  await assert.rejects(
    () => openEdpArchiveCore(new TextEncoder().encode("not an archive"), "fake.rar", { readLibarchiveEntries: readLibarchiveEntriesForTest }),
    (error) => error instanceof EdpArchiveError && error.code === "archive_signature_mismatch",
  );

  const unsafe = new JSZip();
  unsafe.file("../escape.pdf", PDF_BYTES);
  const unsafeBytes = await unsafe.generateAsync({ type: "uint8array" });
  await assert.rejects(
    () => openEdpArchiveCore(unsafeBytes, "unsafe.zip", { readLibarchiveEntries: readLibarchiveEntriesForTest }),
    (error) => error instanceof EdpArchiveError && error.code === "unsafe_archive_path",
  );

  const encrypted = new Uint8Array(await readFile(new URL("./fixtures/edp/encrypted-round2.7z", import.meta.url)));
  await assert.rejects(
    () => openEdpArchiveCore(encrypted, "encrypted-round2.7z", { readLibarchiveEntries: readLibarchiveEntriesForTest }),
    (error) => error instanceof EdpArchiveError && error.code === "encrypted_archive",
  );
});

test("multi-format EDP upload accepts nested 7z and RAR archives with authoritative download metadata", async () => {
  const worker = await loadWorker();
  const cases = [
    ["nested-round2.7z", "application/x-7z-compressed", "7z"],
    ["nested-round2.rar", "application/vnd.rar", "rar"],
  ];
  globalThis.__CHEMECAR_TEST_READ_LIBARCHIVE__ = async (bytes) => {
    const entries = await readLibarchiveEntriesForTest(bytes);
    return entries.map((entry) => {
      if (entry.isDirectory || !/\.pdf$/iu.test(entry.pathname)) return entry;
      const pdfBytes = simpleTextPdfBytes(`Readable archive fixture | ${entry.pathname}`);
      return { ...entry, size: pdfBytes.byteLength, bytes: pdfBytes };
    });
  };
  try {
    for (const [fixture, contentType, archiveFormat] of cases) {
      const bytes = new Uint8Array(await readFile(new URL(`./fixtures/edp/${fixture}`, import.meta.url)));
      const file = new File([bytes], fixture, { type: "application/octet-stream" });
      const db = new FakeD1({
        edpReceiptSettings: {
          competition_year: "2026",
          submission_round: 2,
          updated_at: "2026-09-01T00:00:00.000Z",
        },
      });
      const files = new FakeR2();
      const result = await postEdp(worker, { DB: db, FILES: files }, file, {
        submittedAt: "2026-09-02T01:00:00.000Z",
        submissionId: archiveFormat === "7z" ? "701" : "702",
      });
      assert.equal(result.response.status, 201, JSON.stringify(result.payload));
      assert.equal(result.payload.accepted, true);
      assert.equal(result.payload.qualified, true);
      assert.equal(result.payload.submission.archiveFormat, archiveFormat);
      assert.equal(result.payload.submission.fileCount, 4);
      assert.equal(files.putCalls.at(-1).options.httpMetadata.contentType, contentType);
      assert.equal(db.submission.filename, fixture);
      assert.equal(db.submission.content_type, contentType);
    }
  } finally {
    delete globalThis.__CHEMECAR_TEST_READ_LIBARCHIVE__;
  }
});

test("embedded registration follows the standalone latest-version workflow without reversing EDP success", async () => {
  const miniflare = new Miniflare({
    modules: true,
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
    script: "export default { fetch() { return new Response('ok'); } }",
  });
  try {
    const worker = await loadWorker();
    const database = await miniflare.getD1Database("DB");
    const files = new FakeR2();
    const env = await makeAuthEnv({ DB: database, FILES: files });
    const cookie = await authenticatedCookie();
    const boot = await callApi(worker, env, "/api/dashboard", { cookie });
    assert.equal(boot.status, 200, await boot.text());
    await database.prepare(`INSERT INTO edp_receipt_settings
      (user_id, competition_year, submission_round, updated_at)
      VALUES (?, '2026', 2, ?)`)
      .bind("shared-browser-workspace", "2026-09-01T00:00:00.000Z").run();
    await database.prepare(`INSERT INTO registration_receipt_settings
      (user_id, competition_year, qq_group, updated_at)
      VALUES (?, '2026', '123456789', ?)`)
      .bind("shared-browser-workspace", "2026-09-01T00:00:00.000Z").run();

    const packageWithRegistration = async (registrationSchool, registrationName = `${registrationSchool}-报名表.xlsx`) => {
      const archive = new JSZip();
      archive.file("南京工业大学/Chinese-EDP.pdf", simpleTextPdfBytes("University: Nanjing Tech University Vehicle Name: Test Vehicle Faculty Supervisor: Professor Li Supervisor Email: li@example.edu.cn Revision #: 2 Revision Date: 2026-05-23"));
      archive.file("南京工业大学/English-EDP.pdf", simpleTextPdfBytes("University: Nanjing Tech University Vehicle Name: Test Vehicle Faculty Supervisor: Professor Li Supervisor Email: li@example.edu.cn Revision #: 2 Revision Date: 2026-05-23"));
      archive.file("南京工业大学/EDP-Supplement.pdf", simpleTextPdfBytes("Supplement MSDS certificate manufacturer equipment specification"));
      archive.file("南京工业大学/MOC.pdf", simpleTextPdfBytes("Management of Change Description of Change Reasons for Change Safety Evaluation Checklist Approval"));
      archive.file(`南京工业大学/${registrationName}`, registrationWorkbookBytes(registrationSchool, "嵌入报名表测试队"));
      const bytes = await archive.generateAsync({ type: "uint8array" });
      const file = new File([bytes], "华东理工大学-EDP.zip", { type: "application/zip" });
      file.testSubmissionRound = 2;
      return file;
    };

    const first = await postEdp(worker, env, await packageWithRegistration("华东理工大学"), {
      submittedAt: "2026-09-02T01:00:00.000Z",
      submissionId: "801",
    });
    assert.equal(first.response.status, 201, JSON.stringify(first.payload));
    assert.equal(first.payload.accepted, true);
    assert.equal(first.payload.submission.embeddedRegistration.status, "synced");
    assert.match(first.payload.submission.embeddedRegistration.message, /报名表栏目/u);
    const storedRegistration = await database.prepare(`SELECT school_name, submitted_at, submission_id
      FROM collector_registrations WHERE user_id = ? AND school_name = ?`)
      .bind("shared-browser-workspace", "华东理工大学").first();
    assert.deepEqual(storedRegistration, {
      school_name: "华东理工大学",
      submitted_at: "2026-09-02T01:00:00.000Z",
      submission_id: "801",
    });

    const wrongSchool = await postEdp(worker, env, await packageWithRegistration("天津大学", "天津大学-报名表.xlsx"), {
      submittedAt: "2026-09-03T01:00:00.000Z",
      submissionId: "802",
    });
    assert.equal(wrongSchool.payload.accepted, true, JSON.stringify(wrongSchool.payload));
    assert.equal(wrongSchool.payload.qualified, true);
    assert.equal(wrongSchool.payload.submission.embeddedRegistration.status, "invalid");
    assert.match(wrongSchool.payload.submission.embeddedRegistration.message, /学校|单位/u);
    const stillCurrentRegistration = await database.prepare(`SELECT submitted_at, submission_id
      FROM collector_registrations WHERE user_id = ? AND school_name = ?`)
      .bind("shared-browser-workspace", "华东理工大学").first();
    assert.deepEqual(stillCurrentRegistration, {
      submitted_at: "2026-09-02T01:00:00.000Z",
      submission_id: "801",
    });
  } finally {
    await miniflare.dispose();
  }
});

test("validates the ZIP contract before storage and records invalid packages without an R2 write", async () => {
  const [workerSource, packageSource, archiveSource] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/edp-package.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/edp-archive-core.ts", import.meta.url), "utf8"),
  ]);

  assert.match(packageSource, /part\.toLocaleLowerCase\("en-US"\) === "__macosx"/);
  assert.match(packageSource, /leaf\.startsWith\("\._"\)/);
  assert.match(packageSource, /SYSTEM_BASENAMES = new Set\(\["\.ds_store", "thumbs\.db", "desktop\.ini"\]\)/);
  assert.match(packageSource, /expectedPdfCount\(submissionRound\)/);
  assert.match(packageSource, /bytes\[0\] === 0x25[\s\S]*bytes\[4\] === 0x2d/);
  assert.match(packageSource, /supplement\|addendum\|增补\|补充\|补遗/);
  assert.match(packageSource, /english\|英文\|英语/);
  assert.match(packageSource, /matches\.length > 1/);
  assert.match(archiveSource, /unsafe_archive_path/);
  assert.match(workerSource, /inspectEdpPackage\(archiveBytes, filename, receiptSettings\.submissionRound,[\s\S]*validatePdfContents:\s*true/u);

  const uploadStart = workerSource.indexOf("async function uploadEdpSubmission");
  const uploadEnd = workerSource.indexOf("function contentDisposition", uploadStart);
  const uploadBody = workerSource.slice(uploadStart, uploadEnd);
  const invalidStart = uploadBody.indexOf("if (!validation.qualified)");
  const qualifiedStart = uploadBody.indexOf("// Invalid submissions never block", invalidStart);
  const invalidBranch = uploadBody.slice(invalidStart, qualifiedStart);
  assert.ok(uploadStart >= 0 && uploadEnd > uploadStart && invalidStart >= 0 && qualifiedStart > invalidStart);
  assert.match(invalidBranch, /recordEdpIssue/);
  assert.match(invalidBranch, /文件未收集，仅保留问题记录/);
  assert.doesNotMatch(invalidBranch, /FILES\.put|storeEdpIfNewest/);
  assert.ok(uploadBody.indexOf("storeEdpIfNewest") > qualifiedStart, "R2 storage must happen only after validation succeeds");

  const worker = await loadWorker();
  for (const invalidFile of [
    await makeEdpZip({ badEnglishHeader: true }),
    await makeEdpZip({ duplicateChinese: true }),
    await makeEdpZip({ wordChinese: true }),
  ]) {
    const db = new FakeD1();
    const files = new FakeR2();
    const { response, payload } = await postEdp(worker, { DB: db, FILES: files }, invalidFile, {
      submittedAt: "2026-05-03T01:00:00.000Z",
      submissionId: "103",
    });
    assert.equal(response.status, 200);
    assert.equal(payload.accepted, false);
    assert.equal(payload.qualified, false);
    assert.equal(payload.reason, "invalid-package");
    assert.equal(files.putCalls.length, 0, "an invalid ZIP must never be written to R2");
    assert.ok(db.issue, "an invalid ZIP must leave a D1 issue record");
    assert.equal(db.submission, null);
    if (invalidFile.name.endsWith("EDP.zip") && db.issue?.reasons_json?.includes("docx")) {
      assert.match(db.issue.reasons_json, /不是有效 PDF：[^"]*\.docx/u);
    }
  }
});

test("keeps the last qualified EDP, ignores system entries, and permits an optional fourth MOC PDF", async () => {
  const worker = await loadWorker();
  const acceptedV1 = acceptedSubmission();
  const db = new FakeD1({ submission: acceptedV1 });
  const files = new FakeR2();
  files.seed(acceptedV1.r2_key, acceptedV1);
  const env = { DB: db, FILES: files };

  // A newer invalid package records an issue but must not replace or advance the accepted version.
  const invalid = await postEdp(worker, env, await makeEdpZip({ badEnglishHeader: true }), {
    submittedAt: "2026-05-03T01:00:00.000Z",
    submissionId: "300",
  });
  assert.equal(invalid.payload.qualified, false);
  assert.equal(files.putCalls.length, 0);
  assert.equal(db.submission.submission_id, "100");
  assert.equal(db.issue.submission_id, "300");

  // This ZIP is older than the invalid issue, but newer than the last accepted ZIP, so it must be accepted.
  const qualifiedV2 = await postEdp(worker, env, await makeEdpZip(), {
    submittedAt: "2026-05-02T01:00:00.000Z",
    submissionId: "200",
  });
  assert.equal(qualifiedV2.response.status, 200);
  assert.equal(qualifiedV2.payload.accepted, true);
  assert.equal(qualifiedV2.payload.qualified, true);
  assert.equal(qualifiedV2.payload.submission.fileCount, 3, "ignored system entries must not affect the business-file count");
  assert.equal(db.submission.submission_id, "200");
  assert.equal(files.putCalls.length, 1);
  assert.equal(db.issue.submission_id, "300", "a later invalid issue remains visible without replacing the qualified ZIP");

  // A later qualified package may contain the optional MOC as its fourth business PDF.
  const qualifiedV4 = await postEdp(worker, env, await makeEdpZip({ moc: true }), {
    submittedAt: "2026-05-04T01:00:00.000Z",
    submissionId: "400",
  });
  assert.equal(qualifiedV4.payload.accepted, true);
  assert.equal(qualifiedV4.payload.qualified, true);
  assert.equal(qualifiedV4.payload.submission.fileCount, 4);
  assert.equal(db.submission.submission_id, "400");
  assert.equal(db.issue, null, "a newer accepted package clears an older issue");
  assert.equal(files.putCalls.length, 2);

  // An older but otherwise valid ZIP compares only with the accepted version and cannot overwrite it.
  const olderQualified = await postEdp(worker, env, await makeEdpZip(), {
    submittedAt: "2026-05-02T12:00:00.000Z",
    submissionId: "250",
  });
  assert.equal(olderQualified.payload.accepted, false);
  assert.equal(olderQualified.payload.reason, "older-or-equal");
  assert.equal(db.submission.submission_id, "400");
  assert.equal(files.putCalls.length, 2);
});

test("supports EDP rounds one through five when validating files and generating AliMail receipts", async () => {
  const worker = await loadWorker();
  const db = new FakeD1({ registrationReceiptEmail: "team@example.edu.cn" });
  const files = new FakeR2();
  const env = await makeAuthEnv({ DB: db, FILES: files });
  const cookie = await authenticatedCookie();

  const saveSettings = (submissionRound) => callApi(worker, env, "/api/edp-receipt-settings", {
    method: "PUT",
    origin: AUTH_ORIGIN,
    cookie,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ competitionYear: "2025", submissionRound }),
  });

  const invalidSettings = await saveSettings(6);
  assert.equal(invalidSettings.status, 400);
  assert.equal((await invalidSettings.json()).error.code, "invalid_submission_round");

  const firstSettings = await saveSettings(1);
  assert.equal(firstSettings.status, 200);
  assert.deepEqual((await firstSettings.json()).settings.submissionRound, 1);

  const firstRoundQualified = await postEdp(worker, env, await makeEdpZip(), {
    submittedAt: "2026-06-01T01:00:00.000Z",
    submissionId: "501",
  });
  assert.equal(firstRoundQualified.payload.qualified, true);
  assert.equal(firstRoundQualified.payload.submission.receipt.status, "qualified");
  assert.equal(firstRoundQualified.payload.submission.receipt.recipientEmail, "team@example.edu.cn");
  assert.match(firstRoundQualified.payload.submission.receipt.subject, /EDP提交成功回执/u);
  assert.match(firstRoundQualified.payload.submission.receipt.body, /已成功提交2025年Chem-E-Car®竞赛EDP【第1次】/u);

  const firstRoundWithMoc = await postEdp(worker, env, await makeEdpZip({ moc: true }), {
    submittedAt: "2026-06-02T01:00:00.000Z",
    submissionId: "502",
  });
  assert.equal(firstRoundWithMoc.payload.qualified, false);
  assert.equal(firstRoundWithMoc.payload.issue.receipt.status, "unqualified");
  assert.ok(firstRoundWithMoc.payload.issue.receipt.reasons.some((reason) => /第1次提交应包含.*3 个 PDF/u.test(reason)));
  assert.ok(firstRoundWithMoc.payload.issue.receipt.reasons.some((reason) => /不应包含 MOC/u.test(reason)));
  assert.match(firstRoundWithMoc.payload.issue.receipt.body, /未成功提交2025年Chem-E-Car®竞赛EDP（第1次）/u);
  assert.equal(files.putCalls.length, 1, "a round-one package with MOC must not replace the accepted ZIP");

  for (const submissionRound of [2, 3, 4, 5]) {
    const settingsResponse = await saveSettings(submissionRound);
    const settingsPayload = await settingsResponse.json();
    assert.equal(settingsResponse.status, 200, `round ${submissionRound} settings must be accepted: ${JSON.stringify(settingsPayload)}`);
    assert.equal(settingsPayload.settings.submissionRound, submissionRound);

    const baseId = 500 + submissionRound * 10;
    const missingDay = String(submissionRound * 2 + 1).padStart(2, "0");
    const qualifiedDay = String(submissionRound * 2 + 2).padStart(2, "0");
    const missingMoc = await postEdp(worker, env, await makeEdpZip(), {
      submittedAt: `2026-06-${missingDay}T01:00:00.000Z`,
      submissionId: String(baseId + 1),
    });
    assert.equal(missingMoc.payload.qualified, false);
    assert.ok(missingMoc.payload.issue.receipt.reasons.some((reason) => new RegExp(`第${submissionRound}次提交应包含.*4 个 PDF`, "u").test(reason)));
    assert.ok(missingMoc.payload.issue.receipt.reasons.some((reason) => /必须包含 1 份 MOC/u.test(reason)));

    const qualified = await postEdp(worker, env, await makeEdpZip({ moc: true }), {
      submittedAt: `2026-06-${qualifiedDay}T01:00:00.000Z`,
      submissionId: String(baseId + 2),
    });
    assert.equal(qualified.payload.qualified, true);
    assert.equal(qualified.payload.submission.receipt.status, "qualified");
    assert.equal(qualified.payload.submission.receipt.expectedFileCount, 4);
    assert.match(qualified.payload.submission.receipt.body, new RegExp(`已成功提交2025年Chem-E-Car®竞赛EDP【第${submissionRound}次】`, "u"));
    assert.equal(db.issue, null, `the newer qualified round-${submissionRound} package clears the older EDP issue`);
  }
});

test("migrates saved EDP receipt settings so rounds three through five persist", async () => {
  const initialMigration = await readFile(new URL("../drizzle/0012_edp_receipts.sql", import.meta.url), "utf8");
  const roundMigration = await readFile(new URL("../drizzle/0013_edp_rounds_one_to_five.sql", import.meta.url), "utf8").catch(() => "");
  assert.notEqual(roundMigration, "", "the database migration for EDP rounds one through five must exist");

  const miniflare = new Miniflare({
    modules: true,
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
    script: "export default { fetch() { return new Response('ok'); } }",
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const migration of [initialMigration, roundMigration]) {
      for (const statement of migration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
      if (migration === initialMigration) {
        await database.prepare(`INSERT INTO edp_receipt_settings
          (user_id, competition_year, submission_round, updated_at)
          VALUES ('shared-browser-workspace', '2025', 2, '2026-08-31T00:00:00.000Z')`).run();
      }
    }

    assert.equal((await database.prepare("SELECT submission_round FROM edp_receipt_settings WHERE user_id = ?")
      .bind("shared-browser-workspace").first()).submission_round, 2, "the migration must preserve the saved round");
    await database.prepare("UPDATE edp_receipt_settings SET submission_round = 5 WHERE user_id = ?")
      .bind("shared-browser-workspace").run();
    assert.equal((await database.prepare("SELECT submission_round FROM edp_receipt_settings WHERE user_id = ?")
      .bind("shared-browser-workspace").first()).submission_round, 5);
    await assert.rejects(
      database.prepare("UPDATE edp_receipt_settings SET submission_round = 6 WHERE user_id = ?")
        .bind("shared-browser-workspace").run(),
      /CHECK constraint failed/u,
    );
  } finally {
    await miniflare.dispose();
  }
});

test("offers all five EDP submission rounds in the operator settings", async () => {
  const dashboard = await readFile(new URL("../app/collector-dashboard.tsx", import.meta.url), "utf8");
  for (const submissionRound of [1, 2, 3, 4, 5]) {
    assert.match(dashboard, new RegExp(`<option value="${submissionRound}">第 ${submissionRound} 次提交</option>`, "u"));
  }
  assert.match(dashboard, /第 1–5 次/u);
});

test("migrates certificate_templates with bounded optional stamp metadata", async () => {
  const migration = await readFile(new URL("../drizzle/0019_certificate_templates.sql", import.meta.url), "utf8").catch(() => "");
  assert.notEqual(migration, "", "the certificate template migration must exist");

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "certificate-template-migration-test" },
  });
  try {
    const database = await miniflare.getD1Database("DB");
    for (const statement of migration.replaceAll("--> statement-breakpoint", "").split(";").map((value) => value.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    await database.prepare(`INSERT INTO certificate_templates (user_id, updated_at)
      VALUES (?, ?)`).bind("shared-browser-workspace", "2026-09-20T00:00:00.000Z").run();
    const row = await database.prepare("SELECT event_name, issuer_text, stamp_r2_key FROM certificate_templates WHERE user_id = ?")
      .bind("shared-browser-workspace").first();
    assert.deepEqual(row, { event_name: "", issuer_text: "", stamp_r2_key: null });
    await assert.rejects(
      database.prepare("UPDATE certificate_templates SET stamp_size = 5242881 WHERE user_id = ?")
        .bind("shared-browser-workspace").run(),
      /CHECK constraint failed/u,
    );
  } finally {
    await miniflare.dispose();
  }
});

test("certificate workspace saves only the reusable template and generates private fields locally", async () => {
  const workspace = await readFile(new URL("../app/certificate-workspace.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const label of ["赛事名称", "落款文字", "公章图片", "学校/参赛队", "奖项名称", "指导教师", "参赛队员", "颁发月份", "生成并下载 PDF", "下载 Canva 数据", "打开 Canva"]) {
    assert.match(workspace, new RegExp(label));
  }
  assert.match(workspace, /\/api\/certificate-template/);
  assert.match(workspace, /createImageBitmap/);
  assert.match(workspace, /renderCertificateCanvas/);
  assert.match(workspace, /canvasToCertificatePdf/);
  assert.match(workspace, /canvaCertificateCsv/);
  assert.match(workspace, /https:\/\/www\.canva\.com\//);
  assert.match(workspace, /不会自动上传姓名/u);
  assert.match(workspace, /type="month"/);
  assert.doesNotMatch(workspace, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(workspace, /JSON\.stringify\([^)]*(schoolName|awardName|instructorsText|membersText)/s);
  for (const selector of ["certificate-workspace", "certificate-template-card", "certificate-form-card", "certificate-preview-card", "certificate-canvas-frame"]) {
    assert.match(css, new RegExp(`\\.${selector}`));
  }
});

test("certificate workspace rejects unsafe stamp uploads and clears stale local certificate output", async () => {
  const workspace = await readFile(new URL("../app/certificate-workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /export default CertificateWorkspace/);
  assert.match(workspace, /resolveCertificateFontFamily/);
  assert.doesNotMatch(workspace, /document\.fonts\.check/);

  const mimeGate = workspace.indexOf('if (file.type !== "image/png" && file.type !== "image/jpeg")');
  const bitmapDecode = workspace.indexOf("createImageBitmap(file)");
  const stampPost = workspace.indexOf('fetch("/api/certificate-template/stamp"');
  assert.ok(mimeGate >= 0, "unsupported stamp MIME types must be rejected locally");
  assert.ok(bitmapDecode > mimeGate, "stamp MIME rejection must happen before image decoding");
  assert.ok(stampPost > mimeGate, "stamp MIME rejection must happen before the stamp POST");

  assert.match(workspace, /function invalidateGeneratedCertificate\(\)[\s\S]*lastPdfRef\.current = null[\s\S]*setDownloadAgainVisible\(false\)/);
  assert.match(workspace, /function updateForm[\s\S]*invalidateGeneratedCertificate\(\)/);
  assert.match(workspace, /function updateTemplateForm[\s\S]*invalidateGeneratedCertificate\(\)/);
  assert.match(workspace, /function clearCertificateDraft\(\)[\s\S]*setForm\(emptyForm\(\)\)[\s\S]*lastPdfRef\.current = null/);
  assert.match(workspace, /清空本次证书信息/);
  assert.match(workspace, /const outputGenerationRef = useRef\(0\)/);
  assert.match(workspace, /outputGenerationRef\.current \+= 1/);
  assert.match(workspace, /const outputGeneration = outputGenerationRef\.current[\s\S]*if \(outputGeneration !== outputGenerationRef\.current\) return/);
});

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

    env.IMAGES = certificateTestImages();
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
    assert.equal(saved.status, 200, await saved.text());
    const row = await DB.prepare("SELECT * FROM certificate_templates WHERE user_id = ?")
      .bind("shared-browser-workspace").first();
    assert.equal(row.event_name, "中国大学生Chem-E-Car®竞赛暨AIChE Chem-E-Car®友谊赛");
    assert.equal(row.issuer_text, "竞赛委员会\n中国化工学会");
    assert.equal(row.school_name, undefined);
    assert.equal(row.members, undefined);

    const fakeForm = new FormData();
    fakeForm.set("stamp", new File([new Uint8Array([1, 2, 3])], "fake.png", { type: "image/png" }));
    assert.ok((await callApi(worker, env, "/api/certificate-template/stamp", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: fakeForm,
    })).status >= 400);

    const undersizedForm = new FormData();
    undersizedForm.set("stamp", new File([testStampPng(299)], "small.png", { type: "image/png" }));
    assert.ok((await callApi(worker, env, "/api/certificate-template/stamp", {
      method: "POST", origin: AUTH_ORIGIN, cookie, body: undersizedForm,
    })).status >= 400);

    const upload = async (filename) => {
      const uploadForm = new FormData();
      uploadForm.set("stamp", new File([testStampPng()], filename, { type: "image/png" }));
      return callApi(worker, env, "/api/certificate-template/stamp", {
        method: "POST", origin: AUTH_ORIGIN, cookie, body: uploadForm,
      });
    };
    const uploaded = await upload("official-stamp.png");
    assert.equal(uploaded.status, 200, await uploaded.text());
    const first = await DB.prepare("SELECT stamp_r2_key FROM certificate_templates WHERE user_id = ?")
      .bind("shared-browser-workspace").first();
    const download = await callApi(worker, env, "/api/certificate-template/stamp", { cookie });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("Cache-Control"), "private, no-store");
    assert.equal(download.headers.get("Content-Type"), "image/png");
    assert.equal(new Uint8Array(await download.arrayBuffer()).byteLength, testStampPng().byteLength);

    const replaced = await upload("official-stamp-replacement.png");
    assert.equal(replaced.status, 200, await replaced.text());
    const second = await DB.prepare("SELECT stamp_r2_key FROM certificate_templates WHERE user_id = ?")
      .bind("shared-browser-workspace").first();
    assert.notEqual(second.stamp_r2_key, first.stamp_r2_key);
    assert.equal(await files.head(first.stamp_r2_key), null);
    assert.notEqual(await files.head(second.stamp_r2_key), null);
  } finally {
    await miniflare.dispose();
  }
});

test("certificate PDF core preserves every allowed name and emits one A4 landscape page", async () => {
  const {
    parseCertificateNames,
    prepareCertificateData,
    createCertificateLayout,
    certificateFilename,
    canvaCertificateCsv,
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
  const layoutText = layout.runs.map(({ text }) => text).join(" ");
  for (const instructor of prepared.data.instructors) assert.equal(layoutText.includes(instructor), true, `missing instructor: ${instructor}`);
  for (const member of prepared.data.members) assert.equal(layoutText.includes(member), true, `missing member: ${member}`);
  assert.equal(certificateFilename(prepared.data), "天津大学-性能竞赛二等奖-获奖证书.pdf");
  const canvaCsv = canvaCertificateCsv(prepared.data);
  assert.ok(canvaCsv.startsWith("\uFEFF竞赛年份,赛事名称,学校参赛队,奖项名称,指导教师,参赛队员,颁发月份,落款文字\r\n"));
  assert.match(canvaCsv, /"竞赛委员会\n中国化工学会"/u);
  assert.match(canvaCsv, /教师一、教师二/u);

  const pdfBytes = buildSinglePageJpegPdf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 3508, 2480);
  assert.equal(new TextDecoder().decode(pdfBytes.slice(0, 8)), "%PDF-1.4");
  const pdf = await (await import("pdfjs-dist/legacy/build/pdf.mjs")).getDocument({ data: pdfBytes }).promise;
  assert.equal(pdf.numPages, 1);
  const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
  assert.ok(Math.abs(viewport.width - 841.89) < 0.1);
  assert.ok(Math.abs(viewport.height - 595.28) < 0.1);
});

test("certificate input limits report fields while duplicate names remain visible", async () => {
  const { prepareCertificateData, createCertificateLayout } = await loadCertificatePdf();
  const completeDraft = {
    competitionYear: "2026",
    eventName: "中国大学生Chem-E-Car®竞赛",
    issuerText: "竞赛委员会",
    schoolName: "天津大学",
    awardName: "性能竞赛二等奖",
    instructorsText: "教师一",
    membersText: "队员一",
    issueMonth: "2026-08",
  };
  const invalid = prepareCertificateData({
    ...completeDraft,
    instructorsText: "教师一、教师二、教师三、教师四、教师五、教师六",
    membersText: Array.from({ length: 16 }, (_, index) => `队员${index + 1}`).join("、"),
    issueMonth: "2026-13",
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors.map(({ field }) => field).sort(), ["instructors", "issueMonth", "members"]);

  const duplicated = prepareCertificateData({ ...completeDraft, membersText: "队员一、队员一" });
  assert.equal(duplicated.ok, true);
  assert.deepEqual(duplicated.data.members, ["队员一", "队员一"]);
  assert.equal(duplicated.warnings.length, 1);

  const longEvent = prepareCertificateData({ ...completeDraft, eventName: "超长赛事名称".repeat(200) });
  assert.equal(longEvent.ok, true);
  const layout = createCertificateLayout(longEvent.data, (text, fontPx) => text.length * fontPx, 3508, 2480);
  assert.equal(layout.overflowField, "eventName");
});

test("certificate rendering requires a loaded local CJK face and draws the stamp at its layout box", async () => {
  const { prepareCertificateData, resolveCertificateFontFamily, renderCertificateCanvas } = await loadCertificatePdf();
  const added = [];
  const fonts = { check: () => true, add: (face) => added.push(face) };
  class LocalFontFace {
    constructor(family, source) { this.family = family; this.source = source; this.status = "unloaded"; }
    async load() {
      if (this.source !== 'local("SimSun")') throw new Error("local font unavailable");
      this.status = "loaded";
      return this;
    }
  }
  const family = await resolveCertificateFontFamily(fonts, LocalFontFace);
  assert.equal(added.length, 1);
  assert.equal(family, added[0].family);
  assert.equal(added[0].source, 'local("SimSun")');
  class MissingFontFace extends LocalFontFace { async load() { throw new Error("not installed"); } }
  await assert.rejects(() => resolveCertificateFontFamily({ check: () => true, add() {} }, MissingFontFace), /未检测到可用的中文证书字体/u);

  const prepared = prepareCertificateData({
    competitionYear: "2026", eventName: "中国大学生Chem-E-Car®竞赛", issuerText: "竞赛委员会",
    schoolName: "天津大学", awardName: "性能竞赛二等奖", instructorsText: "教师一", membersText: "队员一", issueMonth: "2026-08",
  });
  assert.equal(prepared.ok, true);
  const calls = { text: [], image: [], fonts: [] };
  const context = {
    save() {}, restore() {}, translate() {}, rotate() {}, strokeRect() {}, fillRect() {},
    measureText(text) { return { width: text.length * 30 }; },
    fillText(...args) { calls.text.push(args); },
    drawImage(...args) { calls.image.push(args); },
    set font(value) { calls.fonts.push(value); },
    set fillStyle(_value) {}, set strokeStyle(_value) {}, set lineWidth(_value) {}, set textAlign(_value) {}, set textBaseline(_value) {},
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { fonts } });
  try {
    const layout = renderCertificateCanvas(canvas, prepared.data, { width: 400, height: 200 });
    assert.equal(layout.overflowField, null);
    assert.equal(calls.image.length, 1);
    assert.deepEqual(calls.image[0].slice(1), [2818, 1907.5, 310, 155]);
    assert.ok(calls.fonts.every((value) => value.includes(`"${family}"`)));
    assert.ok(calls.text.some(([text]) => text === "参赛队员：队员一"));
    const drawn = calls.text.length;
    context.measureText = () => ({ width: 100, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 99999, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 5 });
    assert.notEqual(renderCertificateCanvas(canvas, prepared.data, { width: 400, height: 200 }).overflowField, null);
    assert.equal(calls.text.length, drawn, "ink overflow must stop rendering before any text is drawn");
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

const finalReviewDraft = {
  competitionYear: "2026", eventName: "中国大学生Chem-E-Car®竞赛", issuerText: "竞赛委员会\n中国化工学会",
  schoolName: "天津大学", awardName: "性能竞赛二等奖", instructorsText: "教师一", membersText: "队员一", issueMonth: "2026-08",
};

test("certificate final review restores six paragraphs and a distinct gold award", async () => {
  const { prepareCertificateData, createCertificateLayout } = await loadCertificatePdf();
  const data = prepareCertificateData(finalReviewDraft).data;
  const layout = createCertificateLayout(data, (text, px) => text.length * px, 3508, 2480);
  assert.equal(layout.overflowField, null);
  assert.deepEqual(layout.runs.map((run) => run.text), ["获奖证书", "天津大学 参赛队：", "在2026 中国大学生Chem-E-Car®竞赛中，表现卓越，并获得", "性能竞赛二等奖", "特发此证，以资鼓励！", "指导教师：教师一", "参赛队员：队员一"]);
  assert.equal(layout.runs[3].color, "#9b6a28");
  assert.ok(layout.runs[3].fontPx > layout.runs[2].fontPx);
});

test("certificate final review keeps long multiline footer inside its reserved rectangle", async () => {
  const { prepareCertificateData, createCertificateLayout } = await loadCertificatePdf();
  const measure = (text, px) => text.length * px;
  for (const issuerText of ["中国大学生化学工程竞赛联合组织委员会", "中国大学生竞赛组织委员会\n化学工程学会竞赛工作委员会\n人工智能与化工教育协会"]) {
    const layout = createCertificateLayout(prepareCertificateData({ ...finalReviewDraft, issuerText }).data, measure, 3508, 2480);
    assert.equal(layout.overflowField, null);
    assert.equal(layout.issuerLines.slice(0, -1).map((run) => run.text).join(""), issuerText.replaceAll("\n", ""));
    for (const run of layout.issuerLines) {
      assert.equal(run.align, "right");
      assert.ok(run.x <= 3208 && run.x - measure(run.text, run.fontPx) >= 2448, run.text);
      assert.ok(run.y - run.fontPx >= 1940 && run.y + run.fontPx * 0.25 <= 2300, run.text);
    }
    for (const run of layout.runs) {
      assert.ok(run.x - measure(run.text, run.fontPx) / 2 >= 120);
      assert.ok(run.x + measure(run.text, run.fontPx) / 2 <= 3388);
      assert.ok(run.y - run.fontPx >= 120 && run.y + run.fontPx * 0.25 <= 2360);
    }
  }
});

test("certificate final review normalizes identical preview and PDF runs including fitted text", async () => {
  const { prepareCertificateData, createCertificateLayout } = await loadCertificatePdf();
  const measure = (text, px) => text.length * px;
  const normalize = (layout, scale) => ({ ...layout, runs: layout.runs.map((run) => ({ ...run, x: run.x / scale, y: run.y / scale, fontPx: run.fontPx / scale })), issuerLines: layout.issuerLines.map((run) => ({ ...run, x: run.x / scale, y: run.y / scale, fontPx: run.fontPx / scale })), stampBox: Object.fromEntries(Object.entries(layout.stampBox).map(([key, value]) => [key, value / scale])) });
  for (let length = 90; length <= 140; length += 1) {
    const data = prepareCertificateData({ ...finalReviewDraft, eventName: "赛".repeat(length) }).data;
    assert.deepEqual(normalize(createCertificateLayout(data, measure, 1754, 1240), 0.5), normalize(createCertificateLayout(data, measure, 3508, 2480), 1), `event length ${length}`);
  }
});

test("certificate final review missing year directs the operator to EDP settings", async () => {
  const { prepareCertificateData } = await loadCertificatePdf();
  const prepared = prepareCertificateData({ ...finalReviewDraft, competitionYear: "" });
  assert.equal(prepared.ok, false);
  assert.match(prepared.errors.find(({ field }) => field === "competitionYear").message, /EDP.*设置/u);
});

test("certificate final review renders read-only year and raster PDF operator guidance", async () => {
  const React = await import("react");
  const jsx = await import("react/jsx-runtime");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const source = await readFile(new URL("../app/certificate-workspace.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 } }).outputText;
  const testModule = { exports: {} };
  const pdf = await loadCertificatePdf();
  runInNewContext(output, { exports: testModule.exports, module: testModule, require: (name) => name === "react" ? React : name === "react/jsx-runtime" ? jsx : pdf });
  const html = renderToStaticMarkup(React.createElement(testModule.exports.default));
  assert.match(html, /竞赛年份<input[^>]*readOnly=""/u);
  assert.match(html, /EDP.*设置/u);
  assert.match(html, /PDF.*栅格化.*不可搜索.*不可选中/u);
});

function certificateTestImages(decode = async () => new Response(testStampPng())) {
  return { input(stream) { return { transform() { return { async output() { const response = await decode(new Uint8Array(await new Response(stream).arrayBuffer())); return { response: () => response }; } }; } }; } };
}

async function withCertificateReplacementTest(run) {
  const source = await readFile(new URL("../worker/certificate-template-api.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText;
  const { handleCertificateTemplateApi } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DB: "certificate-final-review" } });
  try {
    const DB = await mf.getD1Database("DB");
    const migration = await readFile(new URL("../drizzle/0019_certificate_templates.sql", import.meta.url), "utf8");
    await DB.prepare(migration).run();
    await DB.prepare("INSERT INTO certificate_templates (user_id,event_name,issuer_text,stamp_r2_key,stamp_filename,stamp_content_type,stamp_size,updated_at) VALUES ('test','赛事','委员会','old.png','old.png','image/png',100,'old')").run();
    const FILES = new FakeR2();
    FILES.seedBytes("old.png", testStampPng());
    const env = { DB, FILES, IMAGES: certificateTestImages() };
    const upload = async (bytes = testStampPng(), type = "image/png") => {
      const body = new FormData();
      body.set("stamp", new File([bytes], type === "image/png" ? "stamp.png" : "stamp.jpg", { type }));
      const request = new Request("https://example.test/api/certificate-template/stamp", { method: "POST", body });
      return handleCertificateTemplateApi(request, env, "test", new URL(request.url));
    };
    const pointer = () => DB.prepare("SELECT stamp_r2_key FROM certificate_templates WHERE user_id='test'").first();
    await run({ env, upload, pointer });
  } finally { await mf.dispose(); }
}

test("certificate final review rejects malformed PNG and 14-byte JPEG before replacing a good stamp", async () => {
  await withCertificateReplacementTest(async ({ env, upload, pointer }) => {
    const good = testStampPng();
    const truncatedJpeg = Uint8Array.from([255,216,255,192,0,8,8,1,44,1,44,0,255,217]);
    const badPng = good.slice(); badPng[badPng.length - 20] ^= 0xff;
    for (const [bytes, type] of [[good.slice(0, -3), "image/png"], [badPng, "image/png"], [truncatedJpeg, "image/jpeg"]]) {
      env.IMAGES = certificateTestImages(async () => { throw new Error("invalid compressed image"); });
      const response = await upload(bytes, type);
      assert.equal(response.status, 415);
      assert.equal((await pointer()).stamp_r2_key, "old.png");
      assert.equal(env.FILES.objects.size, 1);
      assert.equal(env.FILES.putCalls.length, 0);
    }
  });
});

test("certificate final review fails closed when decoder is absent or output stream fails", async () => {
  await withCertificateReplacementTest(async ({ env, upload, pointer }) => {
    for (const decoder of [undefined, certificateTestImages(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("decode stream failure")); } })))]) {
      env.IMAGES = decoder;
      const response = await upload();
      assert.ok(response.status >= 400);
      assert.equal((await pointer()).stamp_r2_key, "old.png");
      assert.equal(env.FILES.putCalls.length, 0);
    }
  });
});

test("certificate final review rejects incomplete image structure even if decoder is permissive", async () => {
  await withCertificateReplacementTest(async ({ env, upload, pointer }) => {
    const bytes = Uint8Array.from([255,216,255,192,0,8,8,1,44,1,44,0,255,217]);
    assert.equal((await upload(bytes, "image/jpeg")).status, 415);
    const badCrc = testStampPng(); badCrc[29] ^= 0xff;
    assert.equal((await upload(badCrc)).status, 415);
    assert.equal((await pointer()).stamp_r2_key, "old.png");
    assert.equal(env.FILES.putCalls.length, 0);
  });
});

test("certificate final review bounds decoded image dimensions and output before writes", async () => {
  await withCertificateReplacementTest(async ({ env, upload, pointer }) => {
    let decoded = false;
    env.IMAGES = certificateTestImages(async () => { decoded = true; return new Response(testStampPng()); });
    const signature = testStampPng().slice(0, 8);
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(65535, 0); ihdr.writeUInt32BE(65535, 4); ihdr.set([8,6,0,0,0], 8);
    const huge = Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.from([0]))), pngChunk("IEND", Buffer.alloc(0))]);
    assert.equal((await upload(huge)).status, 422);
    assert.equal(decoded, false);
    for (const response of [new Response(new Uint8Array(5 * 1024 * 1024 + 1)), new Response(null), new Response("decoder failure", { status: 500 })]) {
      env.IMAGES = certificateTestImages(async () => response);
      assert.equal((await upload()).status, 415);
    }
    assert.equal((await pointer()).stamp_r2_key, "old.png");
    assert.equal(env.FILES.putCalls.length, 0);
  });
});

test("certificate final review rolls back new R2 object on D1 failure", async () => {
  await withCertificateReplacementTest(async ({ env, upload, pointer }) => {
    const DB = env.DB;
    env.DB = { prepare(sql) {
      if (/INSERT INTO certificate_templates/u.test(sql)) return { bind() { return { async run() { throw new Error("D1 write failed"); } }; } };
      return DB.prepare(sql);
    } };
    assert.equal((await upload()).status, 500);
    assert.equal((await pointer()).stamp_r2_key, "old.png");
    assert.deepEqual([...env.FILES.objects.keys()], ["old.png"]);
  });
});

test("certificate final review returns committed success when obsolete R2 cleanup fails", async () => {
  await withCertificateReplacementTest(async ({ env, upload, pointer }) => {
    env.FILES.delete = async () => { throw new Error("R2 cleanup failed"); };
    const response = await upload();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).template.stamp.configured, true);
    const key = (await pointer()).stamp_r2_key;
    assert.notEqual(key, "old.png");
    assert.notEqual(await env.FILES.head(key), null);
    assert.notEqual(await env.FILES.head("old.png"), null);
  });
});

test("certificate final review decodes real PNG and JPEG through local IMAGES before storage", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const source = await readFile(new URL("../worker/certificate-template-api.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText;
  const debugOutput = output.replace('console.error("Certificate template API failed");', 'console.error("Certificate template API failed", error.name, error.message);');
  const mf = new Miniflare({ modules: true, compatibilityDate: "2026-05-22", images: { binding: "IMAGES" }, d1Databases: { DB: "certificate-real-images" }, r2Buckets: { FILES: "certificate-real-images" }, script: `${debugOutput}\nexport default {fetch(request, env) { return handleCertificateTemplateApi(request,env,"test",new URL(request.url)); }}` });
  try {
    const DB = await mf.getD1Database("DB");
    const FILES = await mf.getR2Bucket("FILES");
    await DB.prepare(await readFile(new URL("../drizzle/0019_certificate_templates.sql", import.meta.url), "utf8")).run();
    const jpeg = createCanvas(300, 300).toBuffer("image/jpeg");
    const upload = async (bytes, type) => {
      const body = new FormData(); body.set("stamp", new File([bytes], type === "image/png" ? "stamp.png" : "stamp.jpg", { type }));
      const request = new Request("https://example.test/api/certificate-template/stamp", { method: "POST", body });
      return mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.arrayBuffer(),
      });
    };
    for (const [bytes, type] of [[testStampPng(), "image/png"], [jpeg, "image/jpeg"]]) {
      const response = await upload(bytes, type);
      assert.equal(response.status, 200, await response.text());
    }
    const old = await DB.prepare("SELECT stamp_r2_key FROM certificate_templates WHERE user_id='test'").first();
    const truncated = Buffer.concat([jpeg.subarray(0, jpeg.length - 150), Buffer.from([255,217])]);
    const png = testStampPng();
    const invalidZlib = Buffer.concat([png.subarray(0,33), pngChunk("IDAT", Buffer.from([1,2,3,4])), pngChunk("IEND", Buffer.alloc(0))]);
    for (const [bytes, type] of [[truncated, "image/jpeg"], [invalidZlib, "image/png"]]) {
      const response = await upload(bytes, type);
      assert.equal(response.status, 415, await response.text());
      assert.deepEqual(await DB.prepare("SELECT stamp_r2_key FROM certificate_templates WHERE user_id='test'").first(), old);
      assert.notEqual(await FILES.head(old.stamp_r2_key), null);
      assert.equal((await FILES.list()).objects.length, 1);
    }
  } finally { await mf.dispose(); }
});

test("certificate filename falls back when malformed direct caller components are empty", async () => {
  const { certificateFilename } = await loadCertificatePdf();
  assert.equal(certificateFilename({ schoolName: "<>:/\\|?*", awardName: "\u0000" }), "团队获奖证书.pdf");
});

test("certificate PDF export refuses to encode when no approved CJK font is available", async () => {
  const { canvasToCertificatePdf } = await loadCertificatePdf();
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { fonts: { check: () => false } } });
  try {
    await assert.rejects(() => canvasToCertificatePdf({}), /未检测到可用的中文证书字体/u);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("documents the seven-workspace flow and private certificate generation", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /七个工作区/);
  assert.match(readme, /证书制作/);
  assert.match(readme, /赛事名称.*落款.*公章/s);
  assert.match(readme, /学校、奖项、指导教师和参赛队员.*浏览器本地/s);
  assert.match(readme, /不会保存.*证书历史/s);
  assert.match(readme, /当前仅支持逐张生成，不支持批量生成或证书历史管理。/);
});
