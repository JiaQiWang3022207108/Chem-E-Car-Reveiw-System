import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadAudit(filename) {
  const source = await readFile(new URL(`../worker/${filename}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    fileName: filename,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}
const detailed = await loadAudit("edp-detailed-audit.ts");
const cross = await loadAudit("edp-cross-document-audit.ts");
const doc = (role, pages, extra = {}) => ({ role, filename: `${role}.pdf`, pages: ["Cover", ...pages], textQuality: "usable", ...extra });
const bilingual = (cn, en, extras = []) => detailed.auditBilingualObjectiveConsistency([
  ...extras, doc("chinese_edp", cn), doc("english_edp", en),
]);
const rule = (id, documents) => cross.auditCrossDocumentEdp(documents, { submissionRound: 1, competitionYear: "2026" }).find(item => item.ruleId === id);
const detailRule = (id, text) => detailed.auditDetailedEdpDocuments([doc("chinese_edp", [text])]).find(item => item.ruleId === id);

test("bilingual compares normalized unit values rather than spelling", () => {
  const result = bilingual(["动力来源：2H₂ + O₂ → 2H₂O；氢氧化钾浓度 1200 mmol/L，体积 10 mL。"],
    ["Power source: 2H2 + O2 -> 2H2O; potassium hydroxide concentration 1.2 mol / L, volume 0.01 L."]);
  assert.equal(result.status, "yes");
});

test("bilingual does not turn an unmatched unlabelled quantity into proven contradiction", () => {
  assert.equal(bilingual(["控制机制：5 mL。"], ["Control mechanism: 8 mL."]).status, "needs_human");
});

test("same identified chemical concentration mismatch remains a failure with both page locations", () => {
  const result = bilingual(["动力来源：KOH 浓度 1.2 mol/L。"], ["Power source: KOH concentration 1.6 mol/L."],
    [doc("moc", ["Power control modifications 30 mL"])]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /KOH|氢氧化钾/);
  assert.match(result.suggestedComment, /1\.2/);
  assert.match(result.suggestedComment, /1\.6/);
  assert.deepEqual(new Set(result.evidence.map(e => e.documentRole)), new Set(["chinese_edp", "english_edp"]));
  assert.ok(result.evidence.every(e => e.page === 2));
});

test("bilingual ignores stock and history pages when comparing the current reaction", () => {
  const result = bilingual(["动力来源：Zn + 2HCl → ZnCl2 + H2，系统压力 20 kPa。", "历届比赛作品 2024：1 mol/L KOH；2025：2 mol/L KOH。"],
    ["Power source: Zn + 2HCl -> ZnCl2 + H2, system pressure 20 kPa."]);
  assert.equal(result.status, "yes");
});

test("bilingual low-quality text never proves an inconsistency", () => {
  const result = detailed.auditBilingualObjectiveConsistency([
    doc("chinese_edp", ["动力来源：KOH 1.2 mol/L。"]),
    doc("english_edp", ["Power: KOH 6 mol/L"], { textQuality: "low" }),
  ]);
  assert.equal(result.status, "needs_human");
});

test("reaction representation difference without proven semantic contradiction requires review", () => {
  const result = bilingual(["动力来源：Zn + 2HCl → ZnCl2 + H2，压力 20 kPa。"],
    ["Power source: Zn + 2H -> Zn + H2, pressure 20 kPa."]);
  assert.equal(result.status, "needs_human");
});

test("specified operating pressure mismatch still fails after normalization", () => {
  assert.equal(bilingual(["动力来源：系统压力 20 kPa。"], ["Power source: system pressure 25 kPa."]).status, "no");
});

test("same chemical used in different systems is not the same comparable field", () => {
  assert.equal(bilingual(["动力来源：KOH 浓度 1.2 mol/L。"], ["Control mechanism: KOH concentration 1.6 mol/L."]).status, "needs_human");
});

test("unreadable core PDFs do not turn every detailed content rule into a missing-content failure", () => {
  const items = detailed.auditDetailedEdpDocuments([doc("chinese_edp", [], {textQuality:"empty"})]);
  assert.equal(items.find(item => item.ruleId === "power_equation_logic").status, "needs_human");
});

test("quantities in a design paragraph do not prove an absent SOP was quantified", () => {
  assert.equal(detailRule("sop_quantification", "动力来源：盐酸 10 mL 与锌片 2 g 反应。控制机制：自动停止。").status, "no");
});

test("cleanup residue description does not make a quantified reactant dose vague", () => {
  const result = detailRule("sop_quantification", "标准/安全操作页：开始过程：量取盐酸 10 mL，加入锌片 2 g。清洁/废物处理：收集少量固体残渣，全部放入带盖危废容器。");
  assert.equal(result.status, "yes");
});

test("actual vague reactant dosing remains a failure", () => {
  assert.equal(detailRule("sop_quantification", "标准/安全操作页：开始过程：量取适量盐酸，加入锌片 2 g。清洁：收集残渣。").status, "no");
});

test("optional blank auxiliary field is not automatically an EDP defect", () => {
  assert.equal(detailRule("auxiliary_process", "动力来源：Zn + 2HCl → ZnCl2 + H2；压力 20 kPa。控制机制：自动停止。辅助过程：\n潜在风险：腐蚀。").status, "not_applicable");
});

test("written design innovation need not contain a fixed praise keyword", () => {
  const result = detailRule("innovation_statement", "创新点：动力电极采用双层多孔复合结构，控制反应器分成三室，分别容纳反应液与检测器。比赛现场电源插座：不需要。");
  assert.equal(result.status, "yes");
});

test("author-described PPE in either EDP version supplies positive evidence", () => {
  const result = rule("ppe", [doc("chinese_edp", ["标准/安全操作页：配制电解液时佩戴护目镜、耐碱手套和实验服，避免皮肤接触。"]),
    doc("english_edp", ["Specific PPE Requirements: [ ] Gloves [ ] Goggles"])]);
  assert.equal(result?.status, "yes");
  assert.ok(result.evidence.some(e => e.documentRole === "chinese_edp"));
});

test("an unchecked PPE template is not affirmative PPE evidence", () => {
  const result = rule("ppe", [doc("english_edp", ["Specific PPE Requirements: [ ] Gloves [ ] Goggles [ ] Lab coat"])]);
  assert.equal(result?.status, "needs_human");
});

test("KOH used in this year's EDP needs its own SDS rather than another chemical's incompatibility paragraph", () => {
  const result = rule("chemical_sds", [doc("chinese_edp", ["动力来源：电解液氢氧化钾 KOH 1.2 mol/L。"]),
    doc("english_edp", ["Chemical Information Page | Potassium hydroxide KOH concentration 1.2 mol/L."]),
    doc("supplement", ["Safety Data Sheet | Product Name: Zinc | CAS 7440-66-6 | Section 2 Hazards | Incompatible with potassium hydroxide KOH."])]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /氢氧化钾|KOH/);
});

test("a supplement contents list alone never proves SDS coverage", () => {
  const result = rule("chemical_sds", [doc("chinese_edp", ["动力来源：氢氧化钾 KOH 1.2 mol/L。"]),
    doc("english_edp", ["Chemical Information Page | Potassium hydroxide KOH."]),
    doc("supplement", ["目录：KOH SDS 索引，请另行下载安全数据表全文。"])]);
  assert.equal(result.status, "no");
});

test("first-round MOC stays inapplicable even if an unrelated MOC was included in evidence", () => {
  assert.equal(rule("moc", [doc("moc", ["MANAGEMENT OF CHANGE REQUEST FORM"])]).status, "not_applicable");
});

test("a stored English-labelled MOC is reported as wrong document, not bilingual numeric contradiction", () => {
  const result = detailed.auditBilingualObjectiveConsistency([
    doc("chinese_edp", ["动力来源：KOH 1.2 mol/L。"]),
    { role: "english_edp", filename: "English-EDP.pdf", pages: ["Version 1.0 MANAGEMENT OF CHANGE REQUEST FORM Name of Person or Group Requesting Change"], textQuality: "usable" },
  ]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /MOC/);
  assert.ok(result.evidence.some(e => e.filename === "English-EDP.pdf" && e.page === 1));
});

test("Chinese stopping-mechanism heading and equals-sign equations are understood", () => {
  assert.equal(detailRule("control_equation_logic", "制动机制：I2 + 2S2O3 = 2I + S4O6，显色后传感器触发继电器，小车自动停止。潜在风险：泄漏。").status, "yes");
});

test("an electrochemical propulsion explanation is not failed because dose is specified elsewhere", () => {
  assert.equal(detailRule("power_equation_logic", "动力来源：Mg + 2MnO2 + 2H2O → Mg(OH)2 + 2MnOOH，电子通过外电路驱动电机。制动机制：自动停止。").status, "yes");
});

test("auxiliary template instructions are separated from an explicit no-process entry", () => {
  assert.equal(detailRule("auxiliary_process", "辅助过程（不在小车上发生的过程）包括合成燃料、电池充电、制氢等（如适用）：无 制动机制：显色后自动停止。设计过程中隐含的潜在风险：腐蚀。").status, "not_applicable");
});

test("blank SOP stage headings and instructional examples do not prove author completion", () => {
  const text = "标准/安全操作页 请填写各阶段，例如量取盐酸10 mL。紧急停止部分应描述停止步骤。开始过程部分应列出制备流程。起步过程部分应描述起跑线动作。停止过程部分应描述停止步骤。行驶距离调整部分应描述调整步骤。清洁/废物处理部分应列出步骤。步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 紧急停止 开始过程 行驶过程 停止过程 行驶距离调整过程 清洁/废物处理";
  const items = detailed.auditDetailedEdpDocuments([doc("chinese_edp", [text])]);
  assert.equal(items.find(item=>item.ruleId==="sop_stages").status, "no");
  assert.equal(items.find(item=>item.ruleId==="sop_quantification").status, "no");
});

test("a vague fixed-ratio dose cannot be rescued by an unrelated operating temperature", () => {
  assert.equal(detailRule("sop_quantification", "标准/安全操作页：开始过程：配置一定量的高锰酸钾溶液，按照一定配比注入反应器，温度25℃。清洁/废物处理：收集废液。").status, "no");
});

test("a SOP may continue beyond five pages and use the run-process heading", () => {
  const pages = [
    "标准/安全操作页 步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 紧急停止：按下急停按钮切断电机电源。",
    "开始过程：量取盐酸10 mL，称取锌片2 g，戴护目镜和手套。",
    "配制过程续页：在准备区盖紧反应器，使用二次容器承接泄漏。",
    "检查过程续页：检查绝缘导线及固定容器，避免触电。",
    "检查过程续页：核对标签和药品名称，确认危废桶可用。",
    "行驶过程：打开预装反应器阀门。停止过程：传感器触发继电器使车辆自动停止。",
    "行驶距离调整过程：依据化学品体积校准曲线调整溶液。清洁/废物处理：废液装入带盖危废桶。",
  ];
  assert.equal(rule("jsa", [doc("chinese_edp", pages)]).status, "yes");
});

test("explicit refusal to wear PPE is not erased by another positive PPE sentence", () => {
  assert.equal(rule("ppe", [doc("chinese_edp", ["配液时不佩戴护目镜，戴手套。"])]).status, "no");
});

test("a chemical introduced in the current SOP is part of the SDS inventory", () => {
  const result = rule("chemical_sds", [doc("chinese_edp", ["动力来源：锌与氢氧化钾反应。",
    "标准/安全操作页 步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 开始过程：量取乙醇10 mL，称取锌2 g。"]),
    doc("english_edp", ["Chemical Information Page Zinc KOH."]),
    doc("supplement", ["Safety Data Sheet: Zinc. Safety Data Sheet: KOH."])]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /乙醇/);
});

test("current chemical aliases are not confused with chemicals named only in history", () => {
  const result = rule("chemical_sds", [doc("chinese_edp", ["动力来源：KOH 1 mol/L。",
    "历届比赛作品：2025年使用盐酸与锌。"]), doc("english_edp", ["Chemical Information Page KOH."]),
    doc("supplement", ["Safety Data Sheet: KOH."])]);
  assert.equal(result.status, "yes");
});

test("a SDS for a hydrate does not silently cover an explicitly anhydrous chemical", () => {
  const result = rule("chemical_sds", [doc("chinese_edp", ["动力来源：使用无水氯化铝 AlCl3。"]),
    doc("english_edp", ["Chemical Information Page Anhydrous aluminum chloride AlCl3."]),
    doc("supplement", ["Safety Data Sheet | Product Name: Aluminum chloride hexahydrate AlCl3·6H2O | CAS 7784-13-6 | Section 2 Hazards"])]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /无水|水合|形态/);
});

test("a lead-acid battery in the current design remains explicitly disallowed", () => {
  assert.equal(rule("chemical_sds", [doc("chinese_edp", ["控制系统中使用铅酸蓄电池组供电。"]),
    doc("english_edp", ["Chemical Information Page Zinc."]),
    doc("supplement", ["Safety Data Sheet: Zinc."])]).status, "no");
});

test("normal stopping by operator observation and manual power cut is not autonomous", () => {
  const result = rule("rule_violations", [doc("chinese_edp", ["制动机制：观察到碘钟变色后，队员手动切断电机电源，使小车停止。辅助过程：无。严格遵守所有安全及竞赛规则，首次参赛。"])]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /自主|人工|手动/);
});

test("emergency power isolation is not confused with a manually controlled normal stop", () => {
  const result = rule("rule_violations", [doc("chinese_edp", ["制动机制：显色后传感器触发继电器，小车自动停止。辅助过程：无。",
    "标准/安全操作页 步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 紧急停止：发生泄漏时手动切断电机电源。开始过程：准备药品。停止过程：碘钟触发继电器自动停止。严格遵守所有安全及竞赛规则，首次参赛。"])]);
  assert.notEqual(result.status, "no");
});

test("a template's mention of stopping mechanism cannot borrow the propulsion equation", () => {
  const text="描述小车的预期控制模式（制动机制）、辅助流程、主要危险因素及控制措施。描述小车的设计：通过碘钟反应计时，操作员目视变色后手动断电实现停车。动力来源（推进系统）：Zn + 2HCl → ZnCl2 + H2，电能驱动电机。辅助过程：无。制动机制：手动断电开关，观察显色后按下开关使车辆停止。潜在风险：腐蚀。";
  assert.equal(detailRule("control_equation_logic",text).status,"no");
});

test("spaces around PDF ionic-charge glyphs do not hide the written propulsion reaction", () => {
  assert.equal(detailRule("power_equation_logic","动力来源（推进系统）：Zn + 2OH ⁻ → ZnO + H ₂ O + 2e ⁻；电池驱动电机。辅助过程：无。").status,"yes");
});

test("an auxiliary charging voltage is an operating condition even without the word voltage", () => {
  assert.equal(detailRule("auxiliary_process","辅助过程（如适用）：电池充电采用电沉积法，在2.5V下合成活性材料。制动机制：化学显色停止。").status,"yes");
});

test("auxiliary operating conditions may be provided in the dedicated later table", () => {
  assert.equal(detailRule("auxiliary_process","辅助过程（如适用）：预制碱性电解质凝胶并浸润电极，配制反应溶液。制动机制：自动停止。对于辅助过程（如果适用）预期操作条件：温度24-28℃，压力大气压。标准/安全操作页：戴手套和护目镜。").status,"yes");
});

test("a manually operated stop switch described before the observation still violates autonomous stopping", () => {
  const text="制动机制：手动断电开关（船型开关）。操作员在观察到碘钟反应变色的瞬间按下开关，切断电机电路，小车依靠惯性停止。设计过程中隐含的潜在风险：电气短路。严格遵守所有安全及竞赛规则，首次参赛。";
  assert.equal(rule("rule_violations",[doc("chinese_edp",[text])]).status,"no");
});

test("Unicode ionic minus glyphs do not hide an electrochemical equation", () => {
  assert.equal(detailRule("power_equation_logic","动力来源（推进系统）：锌-空气原电池：Zn + 2OH⁻ → ZnO + H₂O + 2e⁻；电能驱动电机。辅助过程：无。").status,"yes");
});

test("a negative lead-battery declaration after another reagent does not become a positive battery-use match", () => {
  const result=rule("chemical_sds", [doc("chinese_edp",["本项目使用锌，全部反应物和产物均附有安全数据表 SDS，且不使用含铅电池。"]),
    doc("english_edp",["Chemical Information Page: zinc."]),doc("supplement",["Safety Data Sheet SDS: zinc."])]);
  assert.equal(result.status,"yes");
});

test("the combined start-preparation heading describes a filled SOP stage", () => {
  const text="标准安全操作程序：步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品。紧急停止：1.关闭开关；2.使反应器进入安全状态。开始/准备：称取锌5 g，量取盐酸10 mL。行驶过程：打开固定阀门。停止过程：化学反应触发继电器。行驶距离调整过程：调整试剂体积。清洁和赛后处置：收集全部废液到危废容器。";
  assert.equal(detailRule("sop_stages",text).status,"yes");
});

test("an auxiliary no-entry separated from the next heading by a PDF footer is still inapplicable", () => {
  const text="辅助过程（不在小车上发生的过程）包括电池充电（如适用）：无 更新于 2026 年 1 月 2 制动机制：化学变色停车。";
  assert.equal(detailRule("auxiliary_process",text).status,"not_applicable");
});

test("JSA completeness and unquantified preparation are separate findings", () => {
  const text="标准/安全操作页 步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 紧急停止：关闭开关，防止短路。开始过程：戴护目镜和手套，配置一定量的高锰酸钾溶液，密封反应器。行驶过程：打开预装阀门，避免泄漏。停止过程：显色后继电器自动停车。行驶距离调整过程：依据校准曲线调整化学品。清洁/废物处理：分类收集到带盖危废桶。";
  assert.equal(rule("jsa",[doc("chinese_edp",[text])]).status,"yes");
  assert.equal(detailRule("sop_quantification",text).status,"no");
});

test("a chemical on a later SOP page cannot be missed by the first-three-pages shortcut", () => {
  const result = rule("chemical_sds", [doc("chinese_edp", ["动力来源：锌。",
    "车体说明。", "预期操作条件：常温常压。",
    "标准/安全操作页 步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 开始过程：量取乙醇10 mL，称取锌2 g。"]),
    doc("english_edp", ["Chemical Information Page Zinc."]),
    doc("supplement", ["Safety Data Sheet: Zinc."])]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /乙醇/);
});

for (const [name, formula] of [
  ["碘酸钾", "KIO3"], ["碘化钾", "KI"], ["亚硫酸钠", "Na2SO3"],
  ["亚硫酸氢钠", "NaHSO3"], ["硫代硫酸钠", "Na2S2O3"],
  ["过硫酸钠", "Na2S2O8"], ["过硫酸钾", "K2S2O8"], ["淀粉", "Starch"],
  ["过氧化氢", "H2O2"], ["硫酸", "H2SO4"], ["硫酸锌", "ZnSO4"], ["硫酸锰", "MnSO4"],
]) {
  test(`current reagent ${formula} needs its own SDS and may be matched without a contents page`, () => {
    const documents = [doc("chinese_edp", [`控制机制：配制${name} ${formula} 溶液。`]),
      doc("english_edp", [`Chemical Information Page ${name} ${formula}.`])];
    const missing = rule("chemical_sds", [...documents, doc("supplement", ["Certificate of Completion."])]);
    assert.equal(missing.status, "no");
    assert.match(missing.suggestedComment, new RegExp(name));
    const supplied = rule("chemical_sds", [...documents, doc("supplement", [`Safety Data Sheet | Product Name: ${name} ${formula} | Section 2 Hazards`])]);
    assert.equal(supplied.status, "yes", supplied.suggestedComment);
  });
}

test("starting-line manual pouring is identified even when a generic compliance declaration is present", () => {
  const result = rule("rule_violations", [doc("chinese_edp", ["标准/安全操作页 步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 开始过程：准备药品。起步过程：在起跑线上手动向电池盒注入电解液10 mL。停止过程：传感器触发继电器。严格遵守所有安全及竞赛规则，首次参赛。"])]);
  assert.equal(result.status, "no");
  assert.match(result.suggestedComment, /起跑|加液|注液/);
});

test("a prefilled fixed reservoir may be activated by opening its valve at the starting line", () => {
  const result = rule("rule_violations", [doc("chinese_edp", ["标准/安全操作页 步骤顺序 潜在危险 控制风险的步骤 所需个人防护用品或设备 开始过程：在准备台量取盐酸10 mL并用无针头注射器移取，装入固定密闭储液瓶。起步过程：在起跑线打开车载阀门使预装溶液混合，不手动加液。停止过程：化学显色后继电器自动停止。严格遵守所有安全及竞赛规则，首次参赛。"])]);
  assert.notEqual(result.status, "no");
});
