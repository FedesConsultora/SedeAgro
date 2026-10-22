import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,generateKeyPairSync,sign
} from 'node:crypto';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  signingBytes,verifiedReleaseRiskContext,verifySecurityOwnerApproval
} from '../verify-release-owner-approval.mjs';

const SHA='a'.repeat(40),OTHER='f'.repeat(40);
const ID=x=>'sha256:'+x.repeat(64);
const H=x=>createHash('sha256').update(x).digest('hex');
const TIME=Date.parse('2026-10-22T13:00:00.000Z');
const time=s=>new Date(TIME+s).toISOString();
const risk={findings:3,CRITICAL:0,HIGH:0,MEDIUM:1,LOW:0,UNKNOWN:2};
const tarName='sedeagro-images-'+SHA+'.tar';
const receiptName='sedeagro-images-'+SHA+'.json';
const receipt={
  head:SHA,archive:{name:tarName,sha256:'c'.repeat(64)},
  images:[
    {service:'backend',tag:'sedeagro-backend-rc:'+SHA,config_id:ID('d')},
    {service:'frontend',tag:'sedeagro-frontend-rc:'+SHA,config_id:ID('e')}
  ]
};
const bytes=Buffer.from(JSON.stringify(receipt)+'\n');
const oci={
  status:'GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED',
  head:SHA,repository:'FedesConsultora/SedeAgro',
  signer_workflow:'FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml',
  source_ref:'refs/heads/main',github_oidc_signature_checked:true,
  subjects:[{name:tarName,sha256:receipt.archive.sha256},
    {name:receiptName,sha256:H(bytes)}]
};
const names=[
  'sedeagro-backend-'+SHA+'.spdx.json',
  'sedeagro-backend-'+SHA+'.trivy.json',
  'sedeagro-frontend-'+SHA+'.spdx.json',
  'sedeagro-frontend-'+SHA+'.trivy.json',
  'sedeagro-security-'+SHA+'.json'
];
const security={
  status:'GITHUB_SIGNED_IMAGE_SECURITY_VERIFIED_RELEASE_NOT_CERTIFIED',
  head:SHA,source_signed:true,images_verified:2,
  subjects:names.map((name,i)=>({name,sha256:String(i).repeat(64)})),
  review:{
    findings:3,severities:{UNKNOWN:2,LOW:0,MEDIUM:1,HIGH:0,CRITICAL:0},
    high_critical_findings:0,release_go:false,
    release_gate:'EXTERNAL_SECURITY_REVIEW_REQUIRED',
    security_owner_review_required:true
  }
};
function buildContext(){
  return verifiedReleaseRiskContext({sha:SHA,oci,security,receiptBytes:bytes});
}
function keys(){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const der=publicKey.export({type:'spki',format:'der'});
  const key_id=H(der);
  return {
    privateKey,key_id,
    registry:{
      schema:'sedeagro-security-owner-trust-v1',
      repository:'FedesConsultora/SedeAgro',
      trusted_keys:[{
        key_id,spki_der_base64:der.toString('base64'),role:'security_owner',
        owner_id:'reviewer.synthetic',revoked:false,
        valid_from:'2026-01-01T00:00:00.000Z',
        valid_until:'2027-01-01T00:00:00.000Z'
      }]
    }
  };
}
const RATIONALE='Reviewed backend zlib MEDIUM CVE-2026-85091 and musl/musl-utils UNKNOWN CVE-2026-107891. This synthetic fixture cannot authorize a deployment.';
function exampleStatement(context=buildContext()){
  return {
    schema:'sedeagro-security-owner-risk-acceptance-v1',
    ...context,
    decision:'ACCEPT_RESIDUAL_IMAGE_RISK_FOR_CANDIDATE_ONLY',
    scope:'SECURITY_RISK_ONLY_NO_DEPLOY_AUTHORIZATION',
    risk_rationale:RATIONALE,
    issued_at:time(-60000),expires_at:time(3600000),
    nonce:'a'.repeat(32)
  };
}
function envelope(keys,statement=exampleStatement()){
  return {statement,signer:{
    key_id:keys.key_id,
    signature_base64:sign(null,signingBytes(statement),keys.privateKey).toString('base64')
  }};
}
function attempt({context=buildContext(),keys:trusted=keys(),approval,nowMs=TIME}={}){
  return verifySecurityOwnerApproval({
    context,registry:trusted.registry,
    approval:approval||envelope(trusted,exampleStatement(context)),nowMs
  });
}

test('real trust registry is deliberately EMPTY — fail-closed before signature',()=>{
  const path=fileURLToPath(new URL('../security-owner-trust.json',import.meta.url));
  const actual=JSON.parse(readFileSync(path,'utf8'));
  assert.deepEqual(actual,{
    schema:'sedeagro-security-owner-trust-v1',
    repository:'FedesConsultora/SedeAgro',trusted_keys:[]
  });
  assert.throws(()=>verifySecurityOwnerApproval({
    approval:envelope(keys()),registry:actual,context:buildContext(),nowMs:TIME
  }),/no authorized human key enrolled/);
});

test('independently verified provenance binds all seven signed subjects and both configs',()=>{
  const context=buildContext();
  assert.equal(context.release_sha,SHA);
  assert.equal(context.oci_receipt_sha256,H(bytes));
  assert.equal(context.security_receipt_sha256,'4'.repeat(64));
  assert.deepEqual(context.risks,risk);
  for(const bad of [
    {sha:OTHER},
    {oci:{...oci,head:OTHER}},
    {oci:{...oci,github_oidc_signature_checked:false}},
    {oci:{...oci,source_ref:'refs/heads/pr'}},
    {oci:{...oci,subjects:oci.subjects.slice(0,1)}},
    {oci:{...oci,subjects:[oci.subjects[0],{...oci.subjects[1],sha256:'e'.repeat(64)}]}},
    {security:{...security,source_signed:false}},
    {security:{...security,subjects:security.subjects.slice(0,4)}},
    {security:{...security,head:OTHER}},
    {security:{...security,review:{...security.review,release_go:true}}},
    {security:{...security,review:{...security.review,
      severities:{...security.review.severities,HIGH:1}}}},
    {receiptBytes:Buffer.from(JSON.stringify({...receipt,head:OTHER}))},
    {receiptBytes:Buffer.from(JSON.stringify({...receipt,
      images:[receipt.images[1],receipt.images[0]]}))},
  ]){
    assert.throws(()=>verifiedReleaseRiskContext({
      sha:SHA,oci,security,receiptBytes:bytes,...bad
    }),/SECURITY_OWNER_APPROVAL_BLOCKED/);
  }
});

test('ephemeral Ed25519 signer proves cryptographic human-risk acceptance ONLY',()=>{
  const result=attempt();
  assert.equal(result.status,'SECURITY_OWNER_IMAGE_RISK_SIGNED_NOT_DEPLOYED');
  assert.equal(result.head,SHA);
  assert.equal(result.production_go,false);
  assert.equal(result.staging_certified,false);
  assert.equal(result.time_of_use_certified,false);
  assert.equal(result.other_owners_approved,false);
  assert.deepEqual(result.accepted_risks,risk);
});

test('self-signed, revoked, wrong-identity, wrong-role and expired owner keys denied',()=>{
  const k=keys(),g=keys();
  const good=envelope(k);
  const mutants=[
    {registry:{...k.registry,trusted_keys:[]}},
    {registry:g.registry},
    {registry:{...k.registry,trusted_keys:[{
      ...k.registry.trusted_keys[0],revoked:true
    }]}},
    {registry:{...k.registry,trusted_keys:[{
      ...k.registry.trusted_keys[0],role:'operations'
    }]}},
    {registry:{...k.registry,trusted_keys:[{
      ...k.registry.trusted_keys[0],owner_id:'wrong!'
    }]}},
    {registry:{...k.registry,trusted_keys:[{
      ...k.registry.trusted_keys[0],key_id:'f'.repeat(64)
    }]}},
    {registry:{...k.registry,trusted_keys:[{
      ...k.registry.trusted_keys[0],
      valid_until:'2026-10-22T12:00:00.000Z'
    }]}},
    {registry:{...k.registry,trusted_keys:[
      k.registry.trusted_keys[0],k.registry.trusted_keys[0]
    ]}}
  ];
  for(const bad of mutants)assert.throws(()=>verifySecurityOwnerApproval({
    context:buildContext(),approval:good,registry:bad.registry,nowMs:TIME
  }),/SECURITY_OWNER_APPROVAL_BLOCKED/);
});

test('detached signature rejects tampering with any independently signed evidence anchor',()=>{
  const k=keys(),ctx=buildContext(),good=envelope(k,exampleStatement(ctx));
  const transforms=[
    s=>{s.release_sha=OTHER;},
    s=>{s.oci_archive_sha256='f'.repeat(64);},
    s=>{s.oci_receipt_sha256='f'.repeat(64);},
    s=>{s.security_receipt_sha256='f'.repeat(64);},
    s=>{s.image_ids.backend=ID('a');},
    s=>{s.image_ids.frontend=ID('b');},
    s=>{s.risks.MEDIUM=0;},
    s=>{s.risks.UNKNOWN=0;},
    s=>{s.risks.HIGH=1;},
    s=>{s.decision='APPROVE_DEPLOY';},
    s=>{s.scope='PRODUCTION_GO';},
    s=>{s.risk_rationale+=' Added misleading summary';},
    s=>{s.nonce='b'.repeat(32);},
    s=>{s.owner_override=true;},
    s=>{s.issued_at=time(-120000);},
    s=>{s.expires_at=time(120000);},
  ];
  for(const apply of transforms){
    const mutated=structuredClone(good);
    apply(mutated.statement);
    assert.throws(()=>verifySecurityOwnerApproval({
      context:ctx,registry:k.registry,approval:mutated,nowMs:TIME
    }),/SECURITY_OWNER_APPROVAL_BLOCKED/);
  }
});

test('approval cross-release replay fails even with same scanner risk',()=>{
  const k=keys(),good=envelope(k);
  const contexts=[
    {...buildContext(),release_sha:OTHER},
    {...buildContext(),oci_archive_sha256:'f'.repeat(64)},
    {...buildContext(),image_ids:{backend:ID('f'),frontend:ID('e')}},
    {...buildContext(),security_receipt_sha256:'f'.repeat(64)},
    {...buildContext(),risks:{...risk,MEDIUM:0,findings:2}}
  ];
  for(const context of contexts)
    assert.throws(()=>verifySecurityOwnerApproval({
      context,registry:k.registry,approval:good,nowMs:TIME
    }),/SECURITY_OWNER_APPROVAL_BLOCKED/);
});

test('timestamps fail closed for stale, future, expired or too-long signed approval',()=>{
  const k=keys(),ctx=buildContext();
  for(const times of [
    {issued_at:time(-24*3600*1000-1),expires_at:time(1000)},
    {issued_at:time(+5*60000+1),expires_at:time(7*60000)},
    {issued_at:time(-3600000),expires_at:time(-1000)},
    {issued_at:time(-60000),expires_at:time(25*3600000)},
    {issued_at:'2026-02-31T13:00:00.000Z'},
    {issued_at:time(0),expires_at:time(0)}
  ]){
    const signed=envelope(k,{...exampleStatement(ctx),...times});
    assert.throws(()=>verifySecurityOwnerApproval({
      context:ctx,registry:k.registry,approval:signed,nowMs:TIME
    }),/SECURITY_OWNER_APPROVAL_BLOCKED/);
  }
});

test('signatures cannot be interchanged, truncated, padded, or silently recoded',()=>{
  const k=keys(),ctx=buildContext(),base=envelope(k);
  for(const value of [
    'invalid',
    Buffer.alloc(64).toString('base64'),
    base.signer.signature_base64.slice(0,-4),
    base.signer.signature_base64.replace(/=/g,''),
    sign(null,signingBytes({...base.statement,nonce:'b'.repeat(32)}),
      k.privateKey).toString('base64')
  ]){
    const mutated={...base,signer:{...base.signer,signature_base64:value}};
    assert.throws(()=>verifySecurityOwnerApproval({
      context:ctx,registry:k.registry,approval:mutated,nowMs:TIME
    }),/SECURITY_OWNER_APPROVAL_BLOCKED/);
  }
});

test('unknown envelope/signature/risk keys and unsafe reason are rejected',()=>{
  const k=keys(),ctx=buildContext(),base=envelope(k);
  const mutants=[
    {...base,allow_deploy:true},
    {...base,signer:{...base.signer,production_go:true}},
    {...base,statement:{...base.statement,risks:{...risk,ignored:1}}},
    {...base,statement:{...base.statement,risk_rationale:'short'}},
    {...base,statement:{...base.statement,risk_rationale:RATIONALE+'\nSECRET'}},
  ];
  for(const approval of mutants)
    assert.throws(()=>verifySecurityOwnerApproval({
      context:ctx,registry:k.registry,approval,nowMs:TIME
    }),/SECURITY_OWNER_APPROVAL_BLOCKED/);
});

test('production CLI rejects with EMPTY registry before gh, Docker or reading secret files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'owner-deny-cli-'));
  const cli=fileURLToPath(new URL('../verify-release-owner-approval.mjs',import.meta.url));
  try{
    const output=spawnSync(process.execPath,[cli,'--sha',SHA,
      '--evidence-dir',dir],{encoding:'utf8',timeout:7000,
      env:{...process.env,GH_TOKEN:'PROTECTED_SECRET_NEVER_LOG',
        JWT_SECRET:'PROTECTED_SECRET_NEVER_LOG'}});
    assert.equal(output.status,2);
    assert.match(output.stderr,/BLOCKED Security Owner risk approval/);
    assert.doesNotMatch(output.stderr+output.stdout,/PROTECTED_SECRET_NEVER_LOG/);
    assert.doesNotMatch(output.stdout,/SECURITY_OWNER_IMAGE_RISK_SIGNED_NOT_DEPLOYED/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('production deployment and Signed CI report remain untouched and explicitly NO-GO',()=>{
  const root=new URL('../../',import.meta.url);
  const gate=readFileSync(new URL('scripts/verify-production-image-admission.mjs',root),'utf8');
  const prod=readFileSync(new URL('scripts/deploy-prod.sh',root),'utf8');
  const workflow=readFileSync(new URL('.github/workflows/postgres-isolation.yml',root),'utf8');
  assert.match(gate,/review\.release_go === true/);
  assert.match(gate,/rebuilds Docker images/);
  assert.match(prod,/docker compose build backend frontend/);
  assert.match(workflow,/scripts\/test\/release-owner-approval\.test\.mjs/);
});
