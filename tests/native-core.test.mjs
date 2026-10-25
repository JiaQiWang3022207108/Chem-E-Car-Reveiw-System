import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const {instance}=await WebAssembly.instantiate(await readFile(new URL("../native/edp_core.wasm",import.meta.url)));
const core=instance.exports;
test("real C++ WASM enforces rounds, roles, invalid PDF and safe aggregation",()=>{
  assert.equal(core.expected_pdf_count(1),3);
  for(const round of [2,3,4,5]) {
    assert.equal(core.expected_pdf_count(round),4);
    assert.equal(core.package_issues(round,4,1,1,1,1,0),0);
    assert.equal(core.package_issues(round,3,1,1,1,0,0),66);
  }
  assert.equal(core.package_issues(2,4,1,1,1,1,1),4);
  assert.equal(core.package_issues(1,4,1,1,1,1,0),66);
  assert.equal(core.package_issues(2,4,2,0,1,1,0),24);
  assert.equal(core.expected_pdf_count(0),-1);
  assert.equal(core.expected_pdf_count(6),-1);
  assert.equal(core.review_status(1,2,40),1);
  assert.equal(core.review_status(0,1,40),2);
  assert.equal(core.review_status(0,0,0),2);
  assert.equal(core.review_status(0,0,40),0);
});
test("C++ comparison rejects unusable numbers and respects exact boundaries",()=>{
  assert.equal(core.compare_metric(0,0.3,0.345),1);
  assert.equal(core.compare_metric(0,0.345,0.345),0);
  assert.equal(core.compare_metric(1,0.345,0.345),1);
  assert.equal(core.compare_metric(2,100,100),1);
  assert.equal(core.compare_metric(3,99,100),0);
  assert.equal(core.compare_metric(4,101,100),1);
  for(const invalid of [NaN,Infinity,-Infinity]) assert.equal(core.compare_metric(1,invalid,1),-1);
  assert.equal(core.compare_metric(-1,0,1),-1);
});
