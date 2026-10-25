import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import JSZip from 'jszip';
import ts from 'typescript';

const source=await readFile(new URL('../worker/edp-review-workbook.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText
  .replaceAll('"jszip"',JSON.stringify(import.meta.resolve('jszip')));
const {buildEdpReviewWorkbook}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const payload={schoolName:'Synthetic University',competitionYear:'2026',submissionRound:2,
  reviewedAt:'2026-10-25T00:00:00Z',overallStatus:'pending',safetyReviewerName:'Synthetic Reviewer',
  safetyReviewerEmail:'reviewer@example.invalid',expertMemberName:'Synthetic Expert',items:[]};

async function withSyntheticSharedStrings(){
  const zip=await JSZip.loadAsync(await readFile(new URL('../public/edp-review-template-v1.xlsx',import.meta.url)));
  const strings=await zip.file('xl/sharedStrings.xml').async('string');
  const base=[...strings.matchAll(/<si\b/gu)].length;
  const extra=['Legacy Instructor Example','legacy.teacher@example.invalid','unreferenced.person@example.invalid','天津大学'];
  zip.file('xl/sharedStrings.xml',strings.replace('</sst>',extra.map(value=>`<si><t>${value}</t></si>`).join('')+'</sst>'));
  let cover=await zip.file('xl/worksheets/sheet1.xml').async('string');
  for(const [cell,index] of [['E6',base],['E7',base+1],['A2',base+3]]){
    const pattern=new RegExp(`<c\\b(?=[^>]*\\br="${cell}")[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`,'u');
    assert.match(cover,pattern);
    cover=cover.replace(pattern,`<c r="${cell}" t="s"><v>${index}</v></c>`);
  }
  zip.file('xl/worksheets/sheet1.xml',cover);
  return zip.generateAsync({type:'uint8array'});
}

test('export erases unknown obsolete identity values from the shared-string table',async()=>{
  const generated=await buildEdpReviewWorkbook(await withSyntheticSharedStrings(),payload);
  const zip=await JSZip.loadAsync(generated);
  const strings=await zip.file('xl/sharedStrings.xml').async('string');
  assert.equal(/Legacy Instructor Example|legacy\.teacher@example\.invalid|unreferenced\.person@example\.invalid/u.test(strings),false,'Obsolete identities must not remain recoverable');
});

test('export keeps referenced worksheet labels even when a label was an old example value',async()=>{
  const generated=await buildEdpReviewWorkbook(await withSyntheticSharedStrings(),payload);
  const zip=await JSZip.loadAsync(generated);
  const strings=await zip.file('xl/sharedStrings.xml').async('string');
  assert.equal(strings.includes('<si><t>天津大学</t></si>'),true,'A referenced worksheet label must be preserved');
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'),/r="A2" t="s"/u);
});
