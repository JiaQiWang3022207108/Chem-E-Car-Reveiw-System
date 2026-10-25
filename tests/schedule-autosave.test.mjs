import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../app/schedule-autosave.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {createAutosave}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
test("date autosave serializes rapid changes and never reports an old value as saved",async()=>{
  let release;
  const requests=[], states=[];
  const saver=createAutosave(async value=>{
    requests.push(value);
    if(value==="2026-06-01") await new Promise(resolve=>{release=resolve;});
  },state=>states.push(state),60_000);
  saver.set("2026-06-01");
  const first=saver.flush();
  await Promise.resolve();
  saver.set("2026-06-03");
  saver.set("2026-06-05");
  assert.deepEqual(requests,["2026-06-01"]);
  release(); await first; await saver.flush();
  assert.deepEqual(requests,["2026-06-01","2026-06-05"]);
  assert.equal(states.filter(x=>x==="saved").length,1);
  saver.dispose();
});
test("failed date save stays dirty and can retry; disposal stops pending writes",async()=>{
  let fail=true,calls=0; const states=[];
  const saver=createAutosave(async()=>{calls++;if(fail)throw Error("offline");},s=>states.push(s),60_000);
  saver.set("2026-06-01");
  await assert.rejects(saver.flush(),/offline/);
  assert.equal(saver.isDirty(),true);
  fail=false; await saver.flush();
  assert.equal(saver.isDirty(),false);
  saver.set("2026-06-02"); saver.dispose(); await saver.flush();
  assert.equal(calls,2);
  assert.ok(states.includes("error"));
});

test("a dashboard read started before an edit stays stale after the save completes",async()=>{
  const saver=createAutosave(async()=>{},()=>{},60_000);
  const oldRead=saver.revision();
  const mayApplyOldRead=saver.captureRead();
  saver.set("2026-04-01");
  await saver.flush();
  assert.equal(saver.isDirty(),false);
  assert.notEqual(saver.revision(),oldRead,"a completed write must still invalidate an older read");
  assert.equal(mayApplyOldRead(),false);
  const freshRead=saver.revision();
  assert.equal(saver.revision(),freshRead);
  saver.dispose();
});

test("a refresh begun during saving cannot apply after the write finishes",async()=>{
  let release;
  const saver=createAutosave(()=>new Promise(resolve=>{release=resolve;}),()=>{},60_000);
  saver.set("2026-04-02");
  const saving=saver.flush();
  await Promise.resolve();
  const mayApply=saver.captureRead();
  release(); await saving;
  assert.equal(saver.isDirty(),false);
  assert.equal(mayApply(),false);
  assert.equal(saver.captureRead()(),true);
  saver.dispose();
});
