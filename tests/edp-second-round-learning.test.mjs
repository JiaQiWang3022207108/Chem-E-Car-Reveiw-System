import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(filename) {
  const source = await readFile(new URL("../worker/" + filename, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText;
  return import("data:text/javascript;base64,"+Buffer.from(output).toString("base64"));
}
const cross = await load("edp-cross-document-audit.ts");
const detailed = await load("edp-detailed-audit.ts");
const builtin = await load("edp-review-rules.ts");
const signal = {imageCount:1,pathPaintCount:0,annotationCount:0};
const doc = (role, pages, signals=pages.map(()=>({imageCount:0,pathPaintCount:0,annotationCount:0}))) =>
  ({role,filename:role+".pdf",pages,pageSignals:signals,textQuality:"usable"});
const item = (id, docs, round=2) => cross.auditCrossDocumentEdp(docs,{submissionRound:round,competitionYear:"2026"}).find(i=>i.ruleId===id)
  ?? builtin.resolveEdpReviewRule(builtin.EDP_REVIEW_RULES.find(rule=>rule.id===id),docs);
const request = "MANAGEMENT OF CHANGE REQUEST FORM Name of Person or Group Requesting Change: Team Date: 2026.5.23 Summary Description of Change: Added secondary containment. Reason(s) for Change: Prevent leakage during the race. Change is: permanent Signature of Requestor: ___";
const approval = "PROCESS CHANGE REQUEST APPROVAL FORM Description of Change as Approved: Added secondary containment. Approved Duration of Change: permanent Signatures of Approval Faculty Adviser: ____ Date: 2026.5.23";
const checklist = "SAFETY EVALUATION CHECKLIST Changes in Facilities: ventilation lighting";
const moc = (pages=[request,approval,checklist], signals=[signal,signal,signal]) => doc("moc",pages,signals);

// Catches accidental use of a page footer as an authored reason.
test("MOC blank reason across a page break remains blank",()=>{
  const p=request.replace("Prevent leakage during the race. Change is: permanent Signature of Requestor: ___","");
  const r=item("moc",[moc([p,"Version 1.0 Change is: permanent Signature of Requestor: ___",approval,checklist],[signal,signal,signal,signal])]);
  assert.equal(r.status,"no");
  assert.match(r.suggestedComment,/理由|原因|Reason/i);
});
test("MOC accepts completed equivalent headings without a colon",()=>{
  assert.notEqual(item("moc",[moc([request.replace("Change: Added","Change Added").replace("Change: Prevent","Change Prevent"),approval,checklist])]).status,"no");
});
test("MOC accepts equivalent change summary and approval labels",()=>{
  const p=request.replace("MANAGEMENT OF CHANGE REQUEST FORM","CHANGE REQUEST MANAGEMENT FORM")
    .replace("Summary Description of Change:","Change summary:").replace("Reason(s) for Change:","Reason for change:")
    .replace("Name of Person or Group Requesting Change:","Name of the individual or group applying for change:");
  const a=approval.replace("Description of Change as Approved:","Description of Approved Changes:");
  assert.notEqual(item("moc",[moc([p,a,checklist])]).status,"no");
});
test("generic description-of-change heading remains a valid authored summary",()=>{
  assert.equal(item("moc",[moc([request.replace("Summary Description","Description"),approval,checklist])]).status,"yes");
});
test("an unknown approval layout is not automatically an empty MOC",()=>{
  const d=request+" Custom approval record reviewed by the adviser.";
  assert.equal(item("moc",[moc([d],[signal])]).status,"needs_human");
});
test("a wholly atmospheric system does not require pressurised-system evidence",()=>{
  const docs=[doc("english_edp",["Pressure Calculations: all components operate at ambient pressure, 0 psig."])];
  assert.equal(item("max_pressure_500psig",docs).status,"not_applicable");
  assert.equal(item("mawp_gt_mop",docs).status,"not_applicable");
});
test("a positive MOP prevents a blanket no-pressure exemption",()=>{
  const docs=[doc("chinese_edp",["无承压系统。系统最大操作压力：250 psig。"])];
  assert.equal(item("max_pressure_500psig",docs).status,"no");
});
test("all stated MOP conditions must be covered before MAWP ratio passes",()=>{
  const docs=[doc("english_edp",["Pressure Calculations: System MAWP: 100 psig; MOP: 80 psig.","Other normal condition MOP: 150 psig."])];
  assert.notEqual(item("mawp_gt_mop",docs).status,"yes");
});
test("MOC missing approval description cannot pass even with signatures",()=>{
  const r=item("moc",[moc([request,approval.replace("Added secondary containment.",""),checklist])]);
  assert.equal(r.status,"no");
  assert.match(r.suggestedComment,/批准|Approval/i);
});
test("MOC applicant and main reviewer signatures can be on following pages",()=>{
  const r=item("moc",[moc([
    request.replace("Signature of Requestor: ___",""),
    "Signature of Requestor: ___",
    approval.replace("Signatures of Approval Faculty Adviser: ____ Date: 2026.5.23",""),
    "Signatures of Approval Faculty Adviser: ____ Date: 2026.5.23",
    checklist,
  ],[{...signal,imageCount:0},signal,{...signal,imageCount:0},signal,{...signal,imageCount:0}])]);
  assert.equal(r.status,"yes");
  assert.ok(r.evidence.some(e=>e.page===2));
  assert.ok(r.evidence.some(e=>e.page===4));
});
test("MOC current filled description is not satisfied by a checklist heading",()=>{
  const r=item("moc",[moc([request.replace("Added secondary containment.",""),approval,checklist])]);
  assert.equal(r.status,"no");
});
test("MOC unrelated optional safety checklist fields need not all be filled",()=>{
  assert.equal(item("moc",[moc()]).status,"yes");
});
test("first-round submission does not require MOC",()=>{
  assert.equal(item("moc",[],1).status,"not_applicable");
});
test("rounds two to five require MOC",()=>{
  for(const round of [2,3,4,5])assert.equal(item("moc",[],round).status,"no");
});
test("a scanned MOC cannot be called empty because no text was extracted",()=>{
  const d={...doc("moc",[""],[signal]),textQuality:"empty"};
  assert.equal(item("moc",[d]).status,"needs_human");
});
test("MOC contradictory replacement electrolytes cannot be auto-approved",()=>{
  const p=request.replace("Added secondary containment.","The electrolyte will be changed to 0.571 mol/L citric acid solution.");
  const a=approval.replace("Added secondary containment.","The electrolyte will be changed to 30% glacial acetic acid solution.");
  const r=item("moc",[moc([p,a,checklist])]);
  assert.equal(r.status,"needs_human");
  assert.match(r.suggestedComment,/电解液|electrolyte/i);
});
const sop = text => detailed.auditDetailedEdpDocuments([doc("chinese_edp",["学校名称：测试大学","标准/安全操作页：准备过程："+text+"。清洁：收集残渣。"])]).find(i=>i.ruleId==="sop_quantification");
test("SOP concentration alone does not specify reagent dosage",()=>{
  assert.equal(sop("配制盐酸浓度 1 mol/L").status,"no");
});
test("SOP room temperature alone does not specify reagent dosage",()=>{
  assert.equal(sop("加入盐酸，在 25 ℃ 下混合反应").status,"no");
});
test("a concentration unit is not mistaken for a volume",()=>{
  assert.equal(sop("配制盐酸 1 mol/L 和硫酸 0.2 mol/L").status,"no");
});
test("SOP actual mass and volume remain quantified",()=>{
  assert.equal(sop("称取锌片 2 g，量取盐酸 10 mL，混合反应").status,"yes");
});
test("vague formula or proportion is not an executable SOP recipe",()=>{
  assert.equal(sop("按照特定配方配制盐酸 10 mL，按一定比例混合电解液").status,"no");
});
test("SOP dosage may be stated in cubic centimetres",()=>{
  assert.equal(sop("量取盐酸 10 cm³，加入锌片 2 g").status,"yes");
});
const operating = text=>[doc("chinese_edp",["学校名称：测试大学","标准/安全操作页：步骤顺序：行驶过程："+text])];
test("actual alligator clip connections fail the safety review",()=>{
  const r=item("rule_violations",operating("用鳄鱼夹连接电池和电机，启动后运行。"));
  assert.equal(r.status,"no");
  assert.match(r.suggestedComment,/鳄鱼夹/);
});
test("explicit removal of alligator clips is not a violation",()=>{
  assert.notEqual(item("rule_violations",operating("不使用鳄鱼夹；改用接线柱连接电池和电机。")).status,"no");
});
test("preloaded fixed valve opening is not manual chemical dosing",()=>{
  assert.notEqual(item("rule_violations",operating("在准备台预装并密封反应液，起跑线只打开车载阀门。")).status,"no");
});
test("actual syringe dosing at the starting line remains forbidden",()=>{
  assert.equal(item("rule_violations",operating("用注射器手动注入盐酸 10 mL，发令后启动。")).status,"no");
});
test("direct chemical wastewater discharge cannot pass complete waste handling",()=>{
  const r=detailed.auditDetailedEdpDocuments([doc("chinese_edp",["标准/安全操作页：废物处理：酸性废液分开收集到带盖容器，贴标签交由危废机构，部分废液稀释后倒入下水道。"])])
    .find(i=>i.ruleId==="waste_handling_detail");
  assert.equal(r.status,"no");
});
test("prohibition of wastewater discharge is not an unsafe disposal action",()=>{
  const r=detailed.auditDetailedEdpDocuments([doc("chinese_edp",["标准/安全操作页：废物处理：酸性废液分开收集到带盖容器，贴标签交由危废机构。禁止排入下水道。"])])
    .find(i=>i.ruleId==="waste_handling_detail");
  assert.equal(r.status,"yes");
});
test("2026 pressure above 200 psig does not pass an outdated 500 psig limit",()=>{
  const r=item("max_pressure_500psig",[doc("english_edp",["Pressure Calculations: System MAWP: 400 psig; MOP: 250 psig."])]);
  assert.equal(r.status,"no");
  assert.match(r.suggestedComment,/200/);
});
test("2026 MOP at the 200 psig boundary is within the absolute cap",()=>{
  assert.equal(item("max_pressure_500psig",[doc("english_edp",["Pressure Calculations: MOP: 200 psig."])]).status,"yes");
});
test("a equipment rating is not the car's operating pressure",()=>{
  assert.equal(item("max_pressure_500psig",[doc("english_edp",["Equipment List: valve maximum pressure rating 500 psig."])]).status,"needs_human");
});
test("2026 MOP exceeding ninety percent of system MAWP fails",()=>{
  assert.equal(item("mawp_gt_mop",[doc("english_edp",["Pressure Calculations: System MAWP: 100 psig; MOP: 95 psig."])]).status,"no");
});
test("2026 MOP at ninety percent of system MAWP is allowed",()=>{
  assert.equal(item("mawp_gt_mop",[doc("english_edp",["Pressure Calculations: System MAWP: 100 psig; MOP: 90 psig."])]).status,"yes");
});
test("pressure comparison converts explicitly gauge units",()=>{
  assert.equal(item("max_pressure_500psig",[doc("english_edp",["Pressure Calculations: MOP: 14 barg."])]).status,"no");
});
test("unconfirmed later annual pressure rules are not guessed from 2026",()=>{
  const r=cross.auditCrossDocumentEdp([doc("english_edp",["Pressure Calculations: MOP: 180 psig."])],{submissionRound:2,competitionYear:"2027"});
  assert.equal(r.find(i=>i.ruleId==="max_pressure_500psig")?.status,"needs_human");
});
const chemicals = (title="Chemical Information Page",current="ZnO",sds="ZnO") => [
  doc("english_edp",["Power source: "+current,title+" Table 1 shipped chemicals: "+current]),
  doc("supplement",["Safety Data Sheet Product Name: "+sds+" | CAS number: 1314-13-2 Section 2 hazards"]),
];
test("equivalent chemical-information table heading is understood",()=>{
  assert.equal(item("chemical_sds",chemicals("Chemical Information Table","KOH","KOH")).status,"yes");
});
test("compact PDF chemical-information headings are understood",()=>{
  assert.equal(item("chemical_sds",chemicals("ChemicalInformationPage","KOH","KOH")).status,"yes");
});
for(const [name,alias] of [["氧化锌","ZnO"],["柠檬酸","citric acid"],["草酸","oxalic acid"],["葡萄糖酸内酯","glucono delta lactone"],["硫酸铜","copper sulfate"]]){
  test("current reagent "+name+" needs matching SDS identity",()=>{
    const docs=chemicals("Chemical Information Page",name,"KOH");
    const r=item("chemical_sds",docs);
    assert.equal(r.status,"no");
    assert.match(r.suggestedComment,new RegExp(name));
    assert.equal(item("chemical_sds",chemicals("Chemical Information Page",name,alias)).status,"yes");
  });
}
test("a copper-sulfate hydrate SDS cannot silently cover an explicitly different shipped CAS",()=>{
  const r=item("chemical_sds",[
    doc("english_edp",["Power source: copper sulfate.","Chemical Information Page Table 1 shipped chemicals: Copper sulfate CAS 7758-98-7"]),
    doc("supplement",["Safety Data Sheet Product Name: Copper sulfate pentahydrate | CAS 7758-99-8 Section 2 hazards"]),
  ]);
  assert.equal(r.status,"no");
  assert.match(r.suggestedComment,/7758-98-7/);
  assert.match(r.suggestedComment,/7758-99-8/);
});
test("SOP container capacity is not the amount of a reagent added",()=>{
  assert.equal(sop("使用 100 mL 烧杯，加入盐酸并混合反应").status,"no");
});
test("inverse concentration units are not reagent mass",()=>{
  assert.equal(sop("配制盐酸浓度 1 g L⁻¹").status,"no");
});
test("waste mixing prohibition cannot conceal an actual drain discharge",()=>{
  const r=detailed.auditDetailedEdpDocuments([doc("chinese_edp",["标准/安全操作页：废物处理：酸性废液分开收集到带盖容器，贴标签交由危废机构，不得混合，部分废液稀释后倒入下水道。"])])
    .find(i=>i.ruleId==="waste_handling_detail");
  assert.equal(r.status,"no");
});
test("an unrelated negative statement cannot conceal alligator clip use",()=>{
  for(const ending of ["不用胶带","改用低压电池"]){
    const r=item("rule_violations",[doc("chinese_edp",["首次参赛。严格遵守所有安全及竞赛规则。","标准/安全操作页：步骤顺序：行驶过程：用鳄鱼夹连接电池和电机，"+ending+"。"])]);
    assert.equal(r.status,"no");
  }
});
test("an unrelated starting-line prohibition cannot conceal syringe dosing",()=>{
  assert.equal(item("rule_violations",operating("不得超出起跑线，用注射器手动注入盐酸 10 mL。")).status,"no");
});
test("opposite copper sulfate hydrate mismatch is equally rejected",()=>{
  const r=item("chemical_sds",[
    doc("english_edp",["Chemical Information Page Table 1 shipped chemicals: Copper sulfate pentahydrate CAS 7758-99-8"]),
    doc("supplement",["Safety Data Sheet Product Name: Copper sulfate | CAS 7758-98-7 Section 2 hazards"]),
  ]);
  assert.equal(r.status,"no");
});
test("another chemical's CAS in a later SDS section is not the SDS product identity",()=>{
  const r=item("chemical_sds",[
    doc("english_edp",["Chemical Information Page Table 1 shipped chemicals: Copper sulfate CAS 7758-98-7"]),
    doc("supplement",["Safety Data Sheet Product Name: Copper sulfate pentahydrate | CAS 7758-99-8 Section 2 hazards. Section 10 Other chemical reference: CAS 7758-98-7"]),
  ]);
  assert.equal(r.status,"no");
});
test("sodium bisulfite is not sulfuric acid",()=>{
  assert.equal(item("chemical_sds",chemicals("Chemical Information Page","亚硫酸氢钠","sodium bisulfite")).status,"yes");
});
test("two system pressure limits on one page are not cross-paired",()=>{
  const r=item("mawp_gt_mop",[doc("english_edp",["Power System MAWP: 100 psig; MOP: 80 psig. Braking System MAWP: 300 psig; MOP: 180 psig."])]);
  assert.equal(r.status,"needs_human");
});
test("standard Copper(II) sulfate spelling is recognized",()=>{
  assert.equal(item("chemical_sds",chemicals("Chemical Information Page","硫酸铜","Copper(II) sulfate")).status,"yes");
});
