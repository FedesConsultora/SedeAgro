import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPilotMobileEvidence, pilotMobileTemplate
} from '../validate-pilot-mobile-evidence.mjs';

const SHA = 'f507814ccdfe0342c5ab8ad21b81f480cf5163ab';
const OTHER = 'e507814ccdfe0342c5ab8ad21b81f480cf5163ab';
const NOW = Date.parse('2026-11-04T14:30:00Z');
const ORIGIN = 'https://staging.sedeagro.test';
const base = () => pilotMobileTemplate(SHA, ORIGIN);
const accepted = () => {
  const doc = base();
  doc.cases = doc.cases.map((entry, index) => ({
    ...entry, status: 'PASS', tested_at: '2026-11-04T14:00:00Z',
    device_profile: entry.device === 'android-chrome' ? 'Android 14 QA' : 'iOS 17 QA',
    browser_version: entry.device === 'android-chrome' ? 'Chrome 142' : 'Safari 18',
    evidence_ref: 'QA-FIELD-' + String(index + 1).padStart(3, '0')
  }));
  return doc;
};

test('MOB matrix enumerates exactly the required Android/iOS physical scenarios', () => {
  const doc = base();
  assert.equal(doc.cases.length, 22);
  assert.deepEqual(doc.cases.filter(x => x.case_id === 'MOB-01').map(x => x.device), ['android-chrome']);
  assert.deepEqual(doc.cases.filter(x => x.case_id === 'MOB-02').map(x => x.device), ['ios-safari']);
  for (let i = 3; i <= 12; i++) {
    assert.deepEqual(doc.cases.filter(x => x.case_id === 'MOB-' + String(i).padStart(2, '0'))
      .map(x => x.device), ['android-chrome', 'ios-safari']);
  }
  const result = inspectPilotMobileEvidence(doc, {expectedSha:SHA, now:NOW});
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.counts.NOT_RUN, 22);
  assert.equal(result.production_go, false);
});

test('all declared PASS cases only reach HUMAN REVIEW, never production GO', () => {
  const result = inspectPilotMobileEvidence(accepted(), {expectedSha:SHA, now:NOW});
  assert.equal(result.status, 'COMPLETE_FOR_HUMAN_REVIEW');
  assert.equal(result.counts.PASS, 22);
  assert.equal(result.missing.length, 0);
  assert.equal(result.device_verified, false);
  assert.equal(result.evidence_verified, false);
  assert.equal(result.human_review_required, true);
  assert.equal(result.production_go, false);
});

test('unexecuted, missing, blocked or failed cases cannot appear complete', () => {
  const missing = accepted();
  missing.cases.pop();
  assert.equal(inspectPilotMobileEvidence(missing, {expectedSha:SHA, now:NOW}).status, 'INCOMPLETE');
  const notRun = accepted();
  notRun.cases[0] = base().cases[0];
  assert.equal(inspectPilotMobileEvidence(notRun, {expectedSha:SHA, now:NOW}).status, 'INCOMPLETE');
  const blocked = accepted();
  blocked.cases[0] = { ...base().cases[0], status: 'BLOCKED', issue_ref: '#163' };
  assert.equal(inspectPilotMobileEvidence(blocked, {expectedSha:SHA, now:NOW}).status, 'BLOCKED');
  const failed = accepted();
  failed.cases[0] = { ...failed.cases[0], status: 'FAIL', issue_ref: '#163' };
  assert.equal(inspectPilotMobileEvidence(failed, {expectedSha:SHA, now:NOW}).status, 'BLOCKED');
});

test('unknown case, wrong device and duplicates must fail closed', () => {
  const doc = accepted();
  doc.cases[0].device = 'ios-safari';
  assert.throws(() => inspectPilotMobileEvidence(doc, {expectedSha:SHA, now:NOW}));
  const dup = accepted();
  dup.cases[1] = { ...dup.cases[0] };
  assert.throws(() => inspectPilotMobileEvidence(dup, {expectedSha:SHA, now:NOW}));
  const extra = accepted();
  extra.cases[0].session_token = 'secret';
  assert.throws(() => inspectPilotMobileEvidence(extra, {expectedSha:SHA, now:NOW}));
  assert.throws(() => inspectPilotMobileEvidence({ ...base(), extra: true }, {expectedSha:SHA, now:NOW}));
});

test('SHA and HTTPS origin are mandatory, no credentials, localhost or mixed release', () => {
  assert.throws(() => pilotMobileTemplate(SHA, 'http://staging.sedeagro.test'));
  assert.throws(() => pilotMobileTemplate(SHA, 'https://user:pass@staging.sedeagro.test'));
  assert.throws(() => pilotMobileTemplate(SHA, 'https://localhost'));
  assert.throws(() => pilotMobileTemplate(SHA, 'https://staging.sedeagro.test/path'));
  assert.throws(() => inspectPilotMobileEvidence(base(), {expectedSha:OTHER, now:NOW}));
  assert.throws(() => inspectPilotMobileEvidence(base(), {expectedSha:'main', now:NOW}));
});

test('timestamps, issue references and private metadata must be coherent', () => {
  const stale = accepted();
  stale.cases[0].tested_at = '2026-10-01T14:00:00Z';
  assert.throws(() => inspectPilotMobileEvidence(stale, {expectedSha:SHA, now:NOW}));
  const future = accepted();
  future.cases[0].tested_at = '2026-11-05T14:00:00Z';
  assert.throws(() => inspectPilotMobileEvidence(future, {expectedSha:SHA, now:NOW}));
  const missingEvidence = accepted();
  missingEvidence.cases[0].evidence_ref = null;
  assert.throws(() => inspectPilotMobileEvidence(missingEvidence, {expectedSha:SHA, now:NOW}));
  const fakePass = accepted();
  fakePass.cases[0].issue_ref = '#163';
  assert.throws(() => inspectPilotMobileEvidence(fakePass, {expectedSha:SHA, now:NOW}));
  const fakeBlocked = accepted();
  fakeBlocked.cases[0] = { ...base().cases[0], status: 'BLOCKED' };
  assert.throws(() => inspectPilotMobileEvidence(fakeBlocked, {expectedSha:SHA, now:NOW}));
  const unsafe = accepted();
  unsafe.cases[0].device_profile = 'Scout email user@example.com';
  assert.throws(() => inspectPilotMobileEvidence(unsafe, {expectedSha:SHA, now:NOW}));
});

const intakeCli = fileURLToPath(new URL('../validate-pilot-mobile-evidence.mjs', import.meta.url));

function privateFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-mob-private-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'evidence.json');
  const doc=accepted();
  const recorded=new Date(Math.floor((Date.now()-60000)/1000)*1000)
    .toISOString().replace('.000Z','Z');
  for(const item of doc.cases)item.tested_at=recorded;
  writeFileSync(file,JSON.stringify(doc),{mode:0o600});
  return {dir,file,doc};
}
function runIntake(file) {
  return spawnSync(process.execPath,[intakeCli,'--file',file,'--sha',SHA],{
    encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH}
  });
}

test('CLI only reviews locally owned private QA file; does not modify it or grant GO',t=>{
  const {file,doc}=privateFixture(t);
  const before=readFileSync(file);
  const result=runIntake(file);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout.slice(0,result.stdout.indexOf('\nEvidencia declarada')));
  assert.equal(output.status,'COMPLETE_FOR_HUMAN_REVIEW');
  assert.equal(output.device_verified,false);
  assert.equal(output.evidence_verified,false);
  assert.equal(output.production_go,false);
  assert.equal(doc.cases.length,22);
  assert.deepEqual(readFileSync(file),before);
});

test('CLI rejects shared QA files, shared parents, symlinks and noncanonical paths',t=>{
  const {file,dir}=privateFixture(t);
  const linked=join(dir,'linked.json');
  symlinkSync(file,linked);
  const nested=join(dir,'shared-parent');
  mkdirSync(nested,{mode:0o755});
  const sharedParentFile=join(nested,'mob.json');
  writeFileSync(sharedParentFile,readFileSync(file),{mode:0o600});
  const invalid=[linked,sharedParentFile,join(dir,'./evidence.json'),file.slice(1)];
  for(const path of invalid) {
    const result=runIntake(path);
    assert.equal(result.status,2,path+' '+result.stderr);
    assert.doesNotMatch(result.stdout,/COMPLETE_FOR_HUMAN_REVIEW/);
    assert.doesNotMatch(result.stdout+result.stderr,/QA-FIELD-/);
  }
  chmodSync(file,0o644);
  const shared=runIntake(file);
  assert.equal(shared.status,2,shared.stderr);
  assert.doesNotMatch(shared.stdout,/COMPLETE_FOR_HUMAN_REVIEW/);
});

test('CLI blocks oversized, malformed and nonregular evidence, without leaking content',t=>{
  const {file,dir}=privateFixture(t);
  writeFileSync(file,'{ "privateToken": "MOB_SECRET" }',{mode:0o600});
  const invalid=runIntake(file);
  assert.equal(invalid.status,2);
  assert.doesNotMatch(invalid.stdout+invalid.stderr,/MOB_SECRET/);
  writeFileSync(file,Buffer.alloc(65537,0x20),{mode:0o600});
  const huge=runIntake(file);
  assert.equal(huge.status,2);
  const folder=join(dir,'directory.json');
  mkdirSync(folder,{mode:0o700});
  const nonFile=runIntake(folder);
  assert.equal(nonFile.status,2);
  for(const r of [huge,nonFile]) {
    assert.doesNotMatch(r.stdout,/COMPLETE_FOR_HUMAN_REVIEW/);
    assert.match(r.stderr,/BLOCKED: expediente MOB/);
  }
});

test('reader uses descriptor-bound no-follow and bounded local read',()=>{
  const source=readFileSync(intakeCli,'utf8');
  assert.match(source,/constants\.O_NOFOLLOW/);
  assert.match(source,/constants\.O_NONBLOCK/);
  assert.match(source,/fstatSync\(fd\)/);
  assert.match(source,/Buffer\.alloc\(65537\)/);
});
