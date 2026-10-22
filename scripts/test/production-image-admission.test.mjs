import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, chmodSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectProductionImageAdmission, verifySignedSecurityDecision } from
  '../verify-production-image-admission.mjs';

const SHA='a'.repeat(40);
const subjects=[
  'sedeagro-backend-'+SHA+'.spdx.json',
  'sedeagro-backend-'+SHA+'.trivy.json',
  'sedeagro-frontend-'+SHA+'.spdx.json',
  'sedeagro-frontend-'+SHA+'.trivy.json',
  'sedeagro-security-'+SHA+'.json'
];
const security=(review={})=>({
  status:'GITHUB_SIGNED_IMAGE_SECURITY_VERIFIED_RELEASE_NOT_CERTIFIED',
  head:SHA,source_signed:true,images_verified:2,
  subjects:subjects.map(name=>({name,sha256:'b'.repeat(64)})),
  review:{findings:3,severities:{CRITICAL:0,HIGH:0,MEDIUM:1,UNKNOWN:2},
    high_critical_findings:0,
    release_gate:'EXTERNAL_SECURITY_REVIEW_REQUIRED',
    security_owner_review_required:true,release_go:false,...review}
});
const artificialApproval=()=>security({
  release_go:true,security_owner_review_required:false,
  release_gate:'APPROVED_FOR_RELEASE'
});
const oci=()=>({
  head:SHA,status:'GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED',
  github_oidc_signature_checked:true,repository:'FedesConsultora/SedeAgro',
  signer_workflow:'FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml',
  source_ref:'refs/heads/main',
  subjects:[{name:'sedeagro-images-'+SHA+'.tar',sha256:'c'.repeat(64)},
    {name:'sedeagro-images-'+SHA+'.json',sha256:'d'.repeat(64)}]
});

function privateDirs(t) {
  const base=mkdtempSync(join(tmpdir(),'sedeagro-admission-unit-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  mkdirSync(join(base,'oci'),{mode:0o700});
  mkdirSync(join(base,'security'),{mode:0o700});
  return base;
}

test('signed scanner output with zero HIGH does NOT constitute signed owner approval',()=>{
  assert.throws(()=>verifySignedSecurityDecision(security(),SHA),
    /approved security-owner release decision missing/);
  assert.equal(verifySignedSecurityDecision(artificialApproval(),SHA).head,SHA);
});

test('wrong SHA, missing/duplicate signed subjects, invalid inventory, false risk posture fail',()=>{
  const candidates=[
    {...security(),head:'f'.repeat(40)},
    {...security(),source_signed:false},
    {...security(),status:'IMAGE_SECURITY_EVIDENCE_VERIFIED_RELEASE_NOT_CERTIFIED'},
    {...security(),subjects:security().subjects.slice(0,4)},
    {...security(),subjects:[...security().subjects.slice(0,4),security().subjects[0]]},
    {...security(),images_verified:1},
    security({release_go:true}),
    security({security_owner_review_required:false}),
    security({release_go:true,security_owner_review_required:false,
      release_gate:'EXTERNAL_SECURITY_REVIEW_REQUIRED'}),
    security({high_critical_findings:1}),
    security({severities:{CRITICAL:0,HIGH:1,MEDIUM:1,UNKNOWN:2},
      high_critical_findings:1}),
    security({findings:-1}),
  ];
  for(const candidate of candidates){
    assert.throws(()=>verifySignedSecurityDecision(candidate,SHA),
      /PRODUCTION_IMAGE_ADMISSION_BLOCKED/);
  }
});

test('production path denies before OCI inspection when authentic CI risk gate is review-only',async t=>{
  const base=privateDirs(t);
  let signedCalls=0,ociCalls=0;
  await assert.rejects(inspectProductionImageAdmission({
    sha:SHA,evidenceDir:base,
    securityVerifier:()=>{signedCalls++;return security();},
    ociVerifier:()=>{ociCalls++;return oci();}
  }),/approved security-owner release decision missing/);
  assert.equal(signedCalls,1);
  assert.equal(ociCalls,0);
});

test('even hypothetical signed owner approval cannot authorize local Docker rebuild',async t=>{
  const base=privateDirs(t);
  let ociCalls=0;
  await assert.rejects(inspectProductionImageAdmission({
    sha:SHA,evidenceDir:base,securityVerifier:()=>artificialApproval(),
    ociVerifier:async args=>{
      ociCalls++;
      assert.equal(args.sha,SHA);
      assert.equal(args.bundlePath,join(base,'oci','sedeagro-images-'+SHA+'.tar'));
      assert.equal(args.receiptPath,join(base,'oci','sedeagro-images-'+SHA+'.json'));
      return oci();
    }
  }),/rebuilds Docker images/);
  assert.equal(ociCalls,1);
});

test('forged OCI attestation identity rejected even with synthetic owner approval',async t=>{
  const base=privateDirs(t);
  for(const changes of [{head:'c'.repeat(40)},{repository:'other/repo'},
    {github_oidc_signature_checked:false},
    {source_ref:'refs/heads/pr'},
    {subjects:[]},
    {status:'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED'}]){
    await assert.rejects(inspectProductionImageAdmission({
      sha:SHA,evidenceDir:base,securityVerifier:()=>artificialApproval(),
      ociVerifier:async()=>({...oci(),...changes})
    }),/exact signed OCI archive/);
  }
});

test('private evidence dir, ownership, symlinks and source-checkout exclusion fail before verifier',async t=>{
  const base=privateDirs(t);
  let calls=0;
  const attempt=dir=>inspectProductionImageAdmission({sha:SHA,evidenceDir:dir,
    securityVerifier:()=>{calls++;return security();},ociVerifier:async()=>oci()});
  await assert.rejects(attempt(''),/dedicated release evidence directory/);
  chmodSync(base,0o755);
  await assert.rejects(attempt(base),/private, canonical/);
  chmodSync(base,0o700);
  const link=join(base,'redirect');
  symlinkSync(join(base,'security'),link);
  await assert.rejects(attempt(link),/private, canonical/);
  const path=fileURLToPath(new URL('../../',import.meta.url));
  await assert.rejects(attempt(path),/private, canonical/);
  assert.equal(calls,0);
});

test('CLI blocks unsigned production evidence without printing credentials',t=>{
  const base=privateDirs(t);
  const cli=fileURLToPath(new URL('../verify-production-image-admission.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[cli,'--sha',SHA,
    '--evidence-dir',base],{encoding:'utf8',timeout:5000,
    env:{...process.env,JWT_SECRET:'NEVER_PRINT_ME_OR_PATH',GH_TOKEN:'NEVER_PRINT_ME_OR_PATH'}});
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/BLOCKED production image admission/);
  assert.doesNotMatch(result.stdout+result.stderr,/NEVER_PRINT_ME_OR_PATH/);
  assert.doesNotMatch(result.stdout,/PASS|GO|APPROVED/);
});

test('preflight explicitly fences rebuild-only deploy flow and pipeline runs admission regression',()=>{
  const prod=readText('../../scripts/deploy-prod.sh');
  const preflight=readText('../../scripts/production-preflight.sh');
  const workflow=readText('../../.github/workflows/postgres-isolation.yml');
  assert.ok(prod.indexOf('bash scripts/production-preflight.sh') <
    prod.indexOf('docker compose build backend frontend'));
  assert.match(prod,/docker compose build backend frontend/);
  assert.match(preflight,/verify-production-image-admission\.mjs/);
  assert.match(workflow,/scripts\/test\/production-image-admission\.test\.mjs/);
});

function readText(relative) {
  return new TextDecoder().decode(
    new Uint8Array(requireRead(relative)));
}
function requireRead(relative) {
  return readFileSync(new URL(relative,import.meta.url));
}
