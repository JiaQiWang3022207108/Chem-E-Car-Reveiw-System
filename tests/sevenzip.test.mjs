import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import SevenZip from "7z-wasm";
const NodeSevenZip = async options => {
  const instance = await SevenZip(options);
  const call = instance.callMain.bind(instance);
  instance.callMain = args => {
    // The Node build sets process.exitCode for CLI failures. Assert its returned
    // status without letting an expected encrypted-file rejection exit the suite.
    const previous = process.exitCode;
    try { return call(args); } finally { process.exitCode = previous; }
  };
  return instance;
};
const data = code => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const compile = async file => ts.transpile((await readFile(new URL(file,import.meta.url),"utf8")),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext});
const archiveUrl = data((await compile("../worker/edp-archive-core.ts")).replace('"jszip"',JSON.stringify(import.meta.resolve("jszip"))));
const {readSevenZipEntries,parseSevenZipListing} = await import(data((await compile("../worker/sevenzip-core.ts")).replace('"./edp-archive-core"',JSON.stringify(archiveUrl))));

test("C++ 7-Zip preserves nested Chinese names and actual PDF bytes",async()=>{
  const seven = await SevenZip({print(){},printErr(){}});
  seven.FS.mkdir("/中国海洋大学");
  const files=["中文版EDP.pdf","English EDP.pdf","EDP增补文件.pdf","MOC.pdf"];
  for(const name of files)seven.FS.writeFile("/中国海洋大学/"+name,new TextEncoder().encode("%PDF-1.7 "+name));
  assert.equal(seven.callMain(["a","-t7z","/sample.7z","/中国海洋大学","-bd"]),0);
  const entries=await readSevenZipEntries(seven.FS.readFile("/sample.7z"),NodeSevenZip);
  const documents=entries.filter(e=>!e.isDirectory);
  assert.equal(documents.length,4);
  for(const name of files){
    const document=documents.find(e=>e.pathname==="中国海洋大学/"+name);
    assert.ok(document,name);
    assert.equal(new TextDecoder().decode(document.bytes),"%PDF-1.7 "+name);
  }
});
test("7-Zip rejects encrypted archives, unsafe paths, duplicates, links and oversized entries",async()=>{
  for(const fixture of ["encrypted-round2.7z"]){
    const bytes=new Uint8Array(await readFile(new URL("./fixtures/edp/"+fixture,import.meta.url)));
    await assert.rejects(()=>readSevenZipEntries(bytes,NodeSevenZip),e=>e.code==="encrypted_archive");
  }
  for(const record of ["Path = ../evil.pdf\nSize = 1","Path = /evil.pdf\nSize = 1","Path = a\nSize = 999999999","Path = a\nSize = 1\nSymbolic Link = /tmp/evil","Path = a\nSize = 1\n\nPath = a\nSize = 1","Path = a\nSize = 1\nSize = 2"]){
    assert.throws(()=>parseSevenZipListing(record));
  }
});
