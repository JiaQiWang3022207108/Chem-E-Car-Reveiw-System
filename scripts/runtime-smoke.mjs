// Real workerd host test, NOT a Node VM with browser globals filled in.
// Optional --archive PATH is read-only and never sent to a public service.
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes,pbkdf2Sync} from "node:crypto";
import {Miniflare,Log,LogLevel} from "miniflare";
import JSZip from "jszip";
import * as XLSX from "xlsx";
const root=fileURLToPath(new URL("../",import.meta.url));
const args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
const archivePath=option("--archive");
const round=Number(option("--round") || 2);
const password=randomBytes(20).toString("base64url"),salt=randomBytes(16);
const hash=["pbkdf2-sha256","100000",salt.toString("base64url"),pbkdf2Sync(password,salt,100000,32,"sha256").toString("base64url")].join("$");
const serverRoot=path.join(root,"dist/server");
// Vite bundles contain dynamic imports; enumerate the emitted modules explicitly.
const emitted=await readdir(serverRoot,{recursive:true});
const modulePaths=["index.js",...emitted.filter(p=>p!=="index.js" && /\.(?:m?js|wasm)$/.test(p))];
const mf=new Miniflare({
  modulesRoot:serverRoot,
  modules:modulePaths.map(p=>({type:p.endsWith(".wasm")?"CompiledWasm":"ESModule",path:path.join(serverRoot,p)})),
  compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],
  log:new Log(LogLevel.ERROR),
  d1Databases:{DB:"isolated-runtime-smoke"},r2Buckets:{FILES:"isolated-runtime-smoke"},
  images:{binding:"IMAGES"},
  bindings:{APP_ACCESS_PASSWORD_HASH:hash,APP_SESSION_SECRET:randomBytes(32).toString("base64url")},
  serviceBindings:{ASSETS:async request=>{
    if(new URL(request.url).pathname==="/edp-review-template-v1.xlsx") return new Response(await readFile(path.join(root,"public/edp-review-template-v1.xlsx")));
    return new Response("not found",{status:404});
  }},
});
const origin="https://runtime.example.test";
let cookie="";
async function call(route,body,method="POST") {
  const headers={Origin:origin,...(cookie?{Cookie:cookie}:{})};
  if(body && !(body instanceof FormData)) headers["Content-Type"]="application/json";
  // Serialize multipart with the host Request; Miniflare uses a separate FormData implementation.
  const request=new Request(origin+route,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  return mf.dispatchFetch(request.url,{method,headers:Object.fromEntries(request.headers),body:method==="GET"?undefined:await request.arrayBuffer()});
}
function pdf(text) {
  const objects=[
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream="BT /F1 12 Tf 50 700 Td ("+text+") Tj ET";
  objects.push("<< /Length "+Buffer.byteLength(stream)+" >>\nstream\n"+stream+"\nendstream");
  let content="%PDF-1.4\n", offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(content));content+=(i+1)+" 0 obj\n"+objects[i]+"\nendobj\n";}
  const xref=Buffer.byteLength(content);
  content+="xref\n0 6\n0000000000 65535 f \n"+offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")+"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"+xref+"\n%%EOF";
  return Buffer.from(content);
}
try {
  assert.equal((await call("/api/edp-reviews",undefined,"GET")).status,401);
  const login=await call("/api/auth/login",{password});
  assert.equal(login.status,200,await login.clone().text());
  cookie=login.headers.get("set-cookie").split(";")[0];
  for(const [url,body] of [
    ["/api/edp-receipt-settings",{competitionYear:"2026",submissionRound:round}],
    ["/api/edp-reviews/settings",{competitionYear:"2026"}],
  ]) assert.equal((await call(url,body,"PUT")).status,200);
  let bytes;
  if(archivePath) bytes=await readFile(archivePath);
  else {
    const zip=new JSZip();
    for(const [name,text] of [["中文版EDP.pdf","Chinese engineering documentation"],["English EDP.pdf","Engineering Documentation Package"],["EDP增补文件.pdf","Supplement MSDS safety certificate"],["MOC.pdf","Management of Change Reasons Approval"]]) zip.file("team/"+name,pdf(text));
    bytes=await zip.generateAsync({type:"uint8array"});
  }
  const form=new FormData();
  form.set("file",new File([bytes],archivePath?path.basename(archivePath):"测试大学-EDP.zip"));
  form.set("schoolName",option("--school") || "测试大学");
  form.set("submittedAt",new Date().toISOString());
  form.set("submissionId","runtime-"+crypto.randomUUID());
  const uploaded=await call("/api/edp-submissions",form);
  const payload=await uploaded.json();
  assert.ok(payload.reviewJob?.jobId,JSON.stringify(payload).slice(0,2000));
  console.log(JSON.stringify({stage:"collected",file:archivePath?path.basename(archivePath):"synthetic.zip",bytes:bytes.length,jobQueued:true}));
  const result=await call("/api/edp-reviews/process-next",{});
  const resultBody=await result.json();
  assert.equal(result.status,200,JSON.stringify(resultBody));
  assert.equal(resultBody.failed,undefined,JSON.stringify(resultBody));
  const preview=await call("/api/edp-reviews/"+payload.reviewJob.jobId,undefined,"GET");
  const detail=await preview.json();
  assert.ok(detail.job.reviewedAt);
  assert.ok(["ready","needs_human"].includes(detail.job.status),JSON.stringify(detail.job));
  assert.ok(detail.items.length>30);
  const counts={};
  for(const item of detail.items) counts[item.finalStatus]=(counts[item.finalStatus]||0)+1;
  console.log(JSON.stringify({stage:"preview",items:detail.items.length,status:detail.job.status,counts,coverFilled:Boolean(detail.job.workName && detail.job.instructorName && detail.job.instructorEmail)}));
  const exported=await call("/api/edp-reviews/export-batch",{jobIds:[payload.reviewJob.jobId]});
  assert.equal(exported.status,200,await exported.clone().text());
  const exportedBytes=await exported.arrayBuffer();
  const workbook=XLSX.read(exportedBytes,{type:"array"});
  assert.deepEqual(workbook.SheetNames,["1) EDP Cover Page","2) EDP Evaluation"]);
  console.log(JSON.stringify({stage:"download",sheets:workbook.SheetNames.length,bytes:exportedBytes.byteLength}));
} finally {await mf.dispose();}
