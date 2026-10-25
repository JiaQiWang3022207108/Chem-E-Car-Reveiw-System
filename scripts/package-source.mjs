// Export the full editable project, not a minified website or a database backup.
// Git's non-ignored file list is an allow-list; extra deny rules protect local
// credentials even if somebody accidentally staged them.
import {execFileSync} from "node:child_process";
import {readFile,writeFile,mkdir,lstat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import JSZip from "jszip";

const root=fileURLToPath(new URL("../",import.meta.url));
const output=path.resolve(process.argv[2] || path.join(root,"outputs","Chem-E-Car-完整源码.zip"));
const files=[...new Set(execFileSync("git",["ls-files","-z","--cached","--others","--exclude-standard"],{
  cwd:root,encoding:"utf8"
}).split("\0").filter(Boolean))].sort();
const archive=new JSZip();
let count=0;
for(const name of files) {
  if (/(^|\/)(?:node_modules|\.git|\.local|\.wrangler|dist|work|outputs|deliverables)(?:\/|$)/u.test(name)) continue;
  if (/(^|\/)\.dev\.vars|(?:^|\/)\.env(?!\.example$)|\.tsbuildinfo$|\.(?:pem|key)$/u.test(name)) continue;
  const absolute=path.join(root,name);
  const info=await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw Error("只允许打包普通源码文件："+name);
  archive.file("Chem-E-Car/"+name,await readFile(absolute));
  count++;
}
for(const required of ["native/edp_core.cpp","native/edp_core.wasm",".vscode/launch.json","package-lock.json","public/edp-review-template-v1.xlsx"]) {
  if (!archive.file("Chem-E-Car/"+required)) throw Error("源码包缺少："+required);
}
const bytes=await archive.generateAsync({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}});
// Reopen with CRC checks before handing the archive to the operator.
await JSZip.loadAsync(bytes,{checkCRC32:true});
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,bytes,{flag:"wx"});
console.log(JSON.stringify({archive:output,files:count,bytes:bytes.length,credentialsIncluded:false}));
