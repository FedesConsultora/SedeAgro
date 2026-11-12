import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectPilotActorEvidence, pilotActorTemplate
} from '../validate-pilot-actor-evidence.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ORIGIN = 'https://staging.sedeagro.example';
const JOURNEY = 'QA-JOURNEY-PILOT-20261112';
const NOW = Date.parse('2026-11-12T12:30:00Z');
const DATE = '2026-11-12T12:00:00Z';
const script = fileURLToPath(new URL('../validate-pilot-actor-evidence.mjs', import.meta.url));
const statuses = new Map([
  ['ACT-01',201],['ACT-02',201],['ACT-03',200],['ACT-04',200],
  ['ACT-05',201],['ACT-06',200],['ACT-07',401],
  ['ACT-08',201],['ACT-09',403],['ACT-10',200],
  ['ACT-11',403],['ACT-12',200],['ACT-13',404],
  ['ACT-14',404],['ACT-15',404]
]);
const fresh = () => pilotActorTemplate(SHA, ORIGIN, JOURNEY);
function accepted() {
  const record = fresh();
  record.cases = record.cases.map((entry,index) => ({
    ...entry, status:'PASS', tested_at:DATE,
    http_status:statuses.get(entry.case_id),
    evidence_ref:'QA-ACTOR-'+String(index+1).padStart(3,'0')
  }));
  return record;
}
const inspect = doc => inspectPilotActorEvidence(doc,{expectedSha:SHA,now:NOW});

test('template starts NOT_RUN with all 15 exact HTTP/role contracts and six distinct principals',()=>{
  const template=fresh();
  assert.equal(template.cases.length,15);
  assert.equal(new Set(template.cases.map(e=>e.actor)).size,6);
  assert.equal(template.cases.every(e=>e.status==='NOT_RUN' && e.http_status===null),true);
  const result=inspect(template);
  assert.equal(result.required_cases,15);
  assert.equal(result.distinct_principals,6);
  assert.equal(result.status,'INCOMPLETE');
  assert.equal(result.counts.NOT_RUN,15);
  assert.equal(result.production_go,false);
});

test('15 declared PASS records only reach independent human review, never GO',()=>{
  const result=inspect(accepted());
  assert.deepEqual(result.counts,{PASS:15,FAIL:0,BLOCKED:0,NOT_RUN:0});
  assert.deepEqual(result.missing,[]);
  assert.equal(result.status,'COMPLETE_FOR_HUMAN_REVIEW');
  assert.equal(result.staging_verified,false);
  assert.equal(result.evidence_verified,false);
  assert.equal(result.independent_review_required,true);
  assert.equal(result.production_go,false);
});

test('missing or NOT_RUN cases cannot represent completion; failures and blocked cases block',()=>{
  const missing=accepted();
  missing.cases.pop();
  assert.equal(inspect(missing).status,'INCOMPLETE');
  assert.deepEqual(inspect(missing).missing,['ACT-15']);
  const notRun=accepted();
  notRun.cases[2]=fresh().cases[2];
  assert.equal(inspect(notRun).status,'INCOMPLETE');
  const fail=accepted();
  fail.cases[8]={...fail.cases[8],status:'FAIL',http_status:200,issue_ref:'#166'};
  assert.equal(inspect(fail).status,'BLOCKED');
  const blocked=accepted();
  blocked.cases[4]={...fresh().cases[4],status:'BLOCKED',issue_ref:'#163'};
  assert.equal(inspect(blocked).status,'BLOCKED');
  const invalidBlock=accepted();
  invalidBlock.cases[4]={...fresh().cases[4],status:'BLOCKED'};
  assert.throws(()=>inspect(invalidBlock));
});

test('PASS cannot claim an incorrect HTTP response even with opaque evidence',()=>{
  for (const [id,status] of [['ACT-07',200],['ACT-09',200],['ACT-13',403],
    ['ACT-01',202],['ACT-12',404]]) {
    const doc=accepted();
    doc.cases.find(c=>c.case_id===id).http_status=status;
    assert.throws(()=>inspect(doc),id);
  }
  const invalid=accepted();
  invalid.cases[3].issue_ref='#123';
  assert.throws(()=>inspect(invalid));
});

test('actor substitutions, duplicate cases or evidence refs, unknown metadata are rejected',()=>{
  const wrongRole=accepted();
  wrongRole.cases[0].actor='tenant-admin-b';
  assert.throws(()=>inspect(wrongRole));
  const duplicate=accepted();
  duplicate.cases[1]={...duplicate.cases[0]};
  assert.throws(()=>inspect(duplicate));
  const duplicateRef=accepted();
  duplicateRef.cases[1].evidence_ref=duplicateRef.cases[0].evidence_ref;
  assert.throws(()=>inspect(duplicateRef));
  const extra=accepted();
  extra.cases[0].jwt='private-secret';
  assert.throws(()=>inspect(extra));
  assert.throws(()=>inspect({...accepted(),metadata:{token:'unsafe'}}));
  const unknownCase=accepted();
  unknownCase.cases[0].case_id='ACT-99';
  assert.throws(()=>inspect(unknownCase));
});

test('staging origin, SHA, journey ID, timestamps and references are strict',()=>{
  for (const origin of [
    'http://staging.example.test','https://user:pass@staging.example.test',
    'https://staging.example.test/path','https://localhost',
    'https://127.0.0.1','https://staging.example.test/?token=x'
  ]) assert.throws(()=>pilotActorTemplate(SHA,origin,JOURNEY),origin);
  assert.throws(()=>pilotActorTemplate('main',ORIGIN,JOURNEY));
  assert.throws(()=>pilotActorTemplate(SHA,ORIGIN,'an-email@example.test'));
  assert.throws(()=>inspectPilotActorEvidence(accepted(),{expectedSha:OTHER,now:NOW}));
  for (const timestamp of ['2026-10-01T12:00:00Z',
    '2026-11-13T12:00:00Z','not-a-date','2026-11-12T12:00:00.000Z']) {
    const doc=accepted();
    doc.cases[0].tested_at=timestamp;
    assert.throws(()=>inspect(doc),timestamp);
  }
  for (const ref of ['https://private.example/secret','QA-X','QA-EXAMPLE@email.test']) {
    const doc=accepted();
    doc.cases[0].evidence_ref=ref;
    assert.throws(()=>inspect(doc),ref);
  }
});

function privateFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-actor-qa-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'actors.json');
  const doc=accepted();
  const now=new Date(Math.floor((Date.now()-60_000)/1000)*1000)
    .toISOString().replace('.000Z','Z');
  for(const c of doc.cases)c.tested_at=now;
  writeFileSync(file,JSON.stringify(doc),{mode:0o600});
  return {dir,file,doc};
}
function cli(...args){
  return spawnSync(process.execPath,[script,...args],{
    encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH}
  });
}

test('CLI handles private absolute evidence read-only without disclosing its records',t=>{
  const {file}=privateFixture(t);
  const before=readFileSync(file);
  const result=cli('--file',file,'--sha',SHA);
  assert.equal(result.status,0,result.stderr);
  const outcome=JSON.parse(result.stdout.trim());
  assert.equal(outcome.status,'COMPLETE_FOR_HUMAN_REVIEW');
  assert.equal(outcome.production_go,false);
  assert.equal(outcome.staging_verified,false);
  assert.doesNotMatch(result.stdout,/QA-ACTOR-/);
  assert.deepEqual(readFileSync(file),before);
});

test('CLI rejects symlinks, world-readable files, noncanonical paths and oversized inputs',t=>{
  const {file,dir}=privateFixture(t);
  const link=join(dir,'shortcut.json');
  symlinkSync(file,link);
  const sharedDir=join(dir,'shared');
  mkdirSync(sharedDir,{mode:0o755});
  chmodSync(sharedDir,0o755);
  const sharedFile=join(sharedDir,'actors.json');
  writeFileSync(sharedFile,readFileSync(file),{mode:0o600});
  for(const badPath of [link,sharedFile,dir+'/./actors.json',file.slice(1)]) {
    const result=cli('--file',badPath,'--sha',SHA);
    assert.equal(result.status,2,badPath+' '+result.stderr);
    assert.doesNotMatch(result.stdout,/COMPLETE_FOR_HUMAN_REVIEW/);
  }
  chmodSync(file,0o644);
  assert.equal(cli('--file',file,'--sha',SHA).status,2);
  chmodSync(file,0o600);
  writeFileSync(file,Buffer.alloc(65537,65));
  assert.equal(cli('--file',file,'--sha',SHA).status,2);
});

test('CLI template cannot prepopulate PASS and produces no hardware certification',()=>{
  const result=cli('--template','--sha',SHA,'--origin',ORIGIN,'--journey',JOURNEY);
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).cases.every(x=>x.status==='NOT_RUN'),true);
  assert.equal(cli('--file','/tmp/not-permitted.json','--sha',SHA).status,2);
});

test('reviewer reuses private descriptor-bound intake and never contacts staging',()=>{
  const source=readFileSync(script,'utf8');
  assert.match(source,/readPrivateMobileEvidence\(args\[1\]\)/);
  assert.doesNotMatch(source,/\bfetch\(|\bhttp\.request\(|\bhttps\.request\(/);
});
