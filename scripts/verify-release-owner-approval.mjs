// 0P.36 — cryptographic human Security Owner risk acceptance, NOT deploy GO.
// The real repository trust roster is EMPTY until a separately reviewed
// human key enrollment. No private keys, signing command or bypass live here.
import {
  createHash, createPublicKey, verify as verifyEd25519
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { verifySecuritySignatures } from './verify-image-security.mjs';
import { verifySignedRelease } from './verify-oci-signed-provenance.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const TRUST=resolve(ROOT,'scripts/security-owner-trust.json');
const SHA40=/^[a-f0-9]{40}$/, HEX64=/^[a-f0-9]{64}$/, ID=/^sha256:[a-f0-9]{64}$/;
const B64=/^[A-Za-z0-9+/]+={0,2}$/;
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SERVICES=['backend','frontend'];
const SEVERITIES=['CRITICAL','HIGH','MEDIUM','LOW','UNKNOWN'];
const DOMAIN='SEDEAGRO_SECURITY_OWNER_RISK_ACCEPTANCE_V1\n';
const APPROVAL_SCHEMA='sedeagro-security-owner-risk-acceptance-v1';
const DECISION='ACCEPT_RESIDUAL_IMAGE_RISK_FOR_CANDIDATE_ONLY';
const SCOPE='SECURITY_RISK_ONLY_NO_DEPLOY_AUTHORIZATION';
const MAX_APPROVAL=16*1024;

function deny(s){throw new Error('SECURITY_OWNER_APPROVAL_BLOCKED: '+s);}
function check(x,s){if(!x)deny(s);}
function shape(o,keys,s){
  check(o&&typeof o==='object'&&!Array.isArray(o)&&
    Object.keys(o).sort().join('|')===keys.slice().sort().join('|'),s);
}
function hash(b){return createHash('sha256').update(b).digest('hex');}
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')
    return '{'+Object.keys(value).sort().map(k=>
      JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function signingBytes(statement){
  return Buffer.from(DOMAIN+canonical(statement)+'\n','utf8');
}
function isoDate(s,description){
  check(typeof s==='string'&&ISO.test(s),'invalid '+description);
  const ms=Date.parse(s);
  check(Number.isSafeInteger(ms)&&new Date(ms).toISOString()===s,
    'impossible '+description);
  return ms;
}
function acceptCounts(risk){
  shape(risk,['findings',...SEVERITIES],'severity inventory incomplete');
  check(SEVERITIES.every(k=>Number.isSafeInteger(risk[k])&&risk[k]>=0&&risk[k]<=15000)&&
    Number.isSafeInteger(risk.findings)&&risk.findings<=15000&&
    SEVERITIES.reduce((n,k)=>n+risk[k],0)===risk.findings&&
    risk.HIGH===0&&risk.CRITICAL===0,
  'unsigned or high/critical risk not acceptable');
}
function trustworthyRegistry(registry,now){
  shape(registry,['schema','repository','trusted_keys'],'trust registry schema invalid');
  check(registry.schema==='sedeagro-security-owner-trust-v1'&&
    registry.repository==='FedesConsultora/SedeAgro'&&
    Array.isArray(registry.trusted_keys)&&registry.trusted_keys.length>0&&
    registry.trusted_keys.length<=10,'no authorized human key enrolled');
  const used=new Set();
  const keys=registry.trusted_keys.map(key=>{
    shape(key,['key_id','spki_der_base64','role','owner_id','valid_from',
      'valid_until','revoked'],'unreviewed signer property');
    check(key.role==='security_owner'&&
      typeof key.owner_id==='string'&&
      /^[a-z0-9][a-z0-9._-]{3,80}$/.test(key.owner_id)&&
      HEX64.test(key.key_id||'')&&
      typeof key.spki_der_base64==='string'&&
      B64.test(key.spki_der_base64)&&key.spki_der_base64.length<1024&&
      typeof key.revoked==='boolean'&&!used.has(key.key_id),
    'invalid/duplicate security owner');
    used.add(key.key_id);
    const der=Buffer.from(key.spki_der_base64,'base64');
    check(der.length>=40&&der.length<512&&
      der.toString('base64')===key.spki_der_base64&&
      hash(der)===key.key_id,
    'Security Owner public key fingerprint mismatch');
    let publicKey;
    try{publicKey=createPublicKey({key:der,format:'der',type:'spki'});}
    catch{deny('invalid signer public key');}
    check(publicKey.asymmetricKeyType==='ed25519',
      'signing key must be Ed25519');
    const since=isoDate(key.valid_from,'key enrollment'),
      until=isoDate(key.valid_until,'key expiry');
    check(since<until,'key window invalid');
    return {...key,publicKey,since,until};
  });
  return keys;
}

export function verifiedReleaseRiskContext({sha,oci,security,receiptBytes}={}){
  check(SHA40.test(sha||'')&&Buffer.isBuffer(receiptBytes)&&
    receiptBytes.length>0&&receiptBytes.length<65536,
  'release SHA and canonical OCI receipt bytes required');
  let receipt;
  try{receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receiptBytes));}
  catch{deny('OCI receipt JSON/UTF8 invalid');}
  check(receipt.head===sha&&Array.isArray(receipt.images)&&
    receipt.images.length===2&&HEX64.test(receipt.archive?.sha256||'')&&
    receipt.archive.name==='sedeagro-images-'+sha+'.tar'&&
    receipt.images.every((i,n)=>i.service===SERVICES[n]&&
      i.tag==='sedeagro-'+i.service+'-rc:'+sha&&ID.test(i.config_id||'')),
  'exact OCI receipt provenance and image identity required');
  const wantedOci=[
    {name:'sedeagro-images-'+sha+'.tar',sha256:receipt.archive.sha256},
    {name:'sedeagro-images-'+sha+'.json',sha256:hash(receiptBytes)}
  ];
  check(oci?.status==='GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED'&&
    oci.head===sha&&oci.repository==='FedesConsultora/SedeAgro'&&
    oci.signer_workflow==='FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml'&&
    oci.source_ref==='refs/heads/main'&&
    oci.github_oidc_signature_checked===true&&
    canonical(oci.subjects)===canonical(wantedOci),
  'GitHub-signed complete OCI TAR/receipt mandatory');
  const expectedSecurity=[
    'sedeagro-backend-'+sha+'.spdx.json',
    'sedeagro-backend-'+sha+'.trivy.json',
    'sedeagro-frontend-'+sha+'.spdx.json',
    'sedeagro-frontend-'+sha+'.trivy.json',
    'sedeagro-security-'+sha+'.json'
  ];
  check(security?.status==='GITHUB_SIGNED_IMAGE_SECURITY_VERIFIED_RELEASE_NOT_CERTIFIED'&&
    security.head===sha&&security.source_signed===true&&
    security.images_verified===2&&
    Array.isArray(security.subjects)&&security.subjects.length===5&&
    security.subjects.every((s,n)=>s?.name===expectedSecurity[n]&&HEX64.test(s.sha256||'')),
  'five exact SHA signed security subjects mandatory');
  const review=security.review;
  check(review?.release_go===false&&
    review.release_gate==='EXTERNAL_SECURITY_REVIEW_REQUIRED'&&
    review.security_owner_review_required===true&&
    review.high_critical_findings===0&&
    Number.isSafeInteger(review.findings)&&
    review.severities&&typeof review.severities==='object',
  'review-only signed security report required; never rewrite CI release_go');
  const risks={findings:review.findings};
  for(const severity of SEVERITIES)
    risks[severity]=review.severities[severity];
  acceptCounts(risks);
  return {
    repository:'FedesConsultora/SedeAgro',
    source_ref:'refs/heads/main',
    release_sha:sha,
    oci_archive_sha256:receipt.archive.sha256,
    oci_receipt_sha256:hash(receiptBytes),
    security_receipt_sha256:security.subjects[4].sha256,
    image_ids:Object.fromEntries(receipt.images.map(i=>[i.service,i.config_id])),
    risks
  };
}

export function verifySecurityOwnerApproval({approval,registry,context,nowMs=Date.now()}={}){
  check(Number.isSafeInteger(nowMs)&&nowMs>=0,'verifier trusted clock invalid');
  const keys=trustworthyRegistry(registry,nowMs);
  shape(approval,['statement','signer'],'signed approval envelope invalid');
  const s=approval.statement;
  shape(s,['schema','repository','source_ref','release_sha',
    'oci_archive_sha256','oci_receipt_sha256','security_receipt_sha256',
    'image_ids','risks','decision','scope','risk_rationale','issued_at',
    'expires_at','nonce'],'risk acceptance statement has unknown fields');
  shape(approval.signer,['key_id','signature_base64'],'detached signature envelope invalid');
  const e=context;
  check(e&&s.schema===APPROVAL_SCHEMA&&
    s.repository==='FedesConsultora/SedeAgro'&&
    s.source_ref==='refs/heads/main'&&s.release_sha===e.release_sha&&
    SHA40.test(s.release_sha||'')&&
    s.oci_archive_sha256===e.oci_archive_sha256&&
    s.oci_receipt_sha256===e.oci_receipt_sha256&&
    s.security_receipt_sha256===e.security_receipt_sha256&&
    HEX64.test(s.oci_archive_sha256||'')&&
    HEX64.test(s.oci_receipt_sha256||'')&&
    HEX64.test(s.security_receipt_sha256||''),
  'security approval does not bind exact signed source, receipts and OCI TAR');
  shape(s.image_ids,['backend','frontend'],'two signed image config IDs required');
  check(SERVICES.every(x=>ID.test(s.image_ids[x]||'')&&
    s.image_ids[x]===e.image_ids?.[x]),
  'approval image config IDs differ from signed TAR');
  acceptCounts(s.risks);
  check(canonical(s.risks)===canonical(e.risks),
    'approval does not acknowledge exact remaining scanner severities');
  check(s.decision===DECISION&&s.scope===SCOPE&&
    typeof s.risk_rationale==='string'&&
    s.risk_rationale.length>=60&&s.risk_rationale.length<=2000&&
    !/[\u0000-\u001f]/.test(s.risk_rationale)&&
    /^[a-f0-9]{32}$/.test(s.nonce||''),
  'explicit bounded owner risk disposition and random nonce required');
  const issued=isoDate(s.issued_at,'issued_at'),
    expires=isoDate(s.expires_at,'expires_at');
  check(expires>issued&&expires-issued<=24*3600*1000&&
    issued<=nowMs+5*60*1000&&issued>=nowMs-24*3600*1000&&
    nowMs<expires,
  'expired, future, overlong or stale risk approval');
  const key=keys.find(k=>k.key_id===approval.signer.key_id);
  check(key&&!key.revoked&&issued>=key.since&&expires<=key.until&&
    nowMs>=key.since&&nowMs<key.until,
  'Security Owner key absent, revoked, expired or not authorized');
  const b64=approval.signer.signature_base64;
  check(typeof b64==='string'&&B64.test(b64)&&b64.length>=80&&b64.length<256,
  'bounded canonical Ed25519 signature required');
  const sig=Buffer.from(b64,'base64');
  check(sig.length===64&&sig.toString('base64')===b64&&
    verifyEd25519(null,signingBytes(s),key.publicKey,sig),
  'Ed25519 owner signature invalid');
  return {
    status:'SECURITY_OWNER_IMAGE_RISK_SIGNED_NOT_DEPLOYED',
    head:s.release_sha,signer_id:key.owner_id,
    signer_key_id:key.key_id,expires_at:s.expires_at,
    scope:SCOPE,accepted_risks:s.risks,
    production_go:false,staging_certified:false,
    time_of_use_certified:false,other_owners_approved:false
  };
}

function privateDir(dir){
  check(typeof dir==='string'&&dir.length>0&&dir.length<4000,
    'private release evidence directory required');
  const p=resolve(dir),stat=lstatSync(p);
  check(stat.isDirectory()&&!stat.isSymbolicLink()&&
    (stat.mode&0o077)===0&&
    (typeof process.getuid!=='function'||stat.uid===process.getuid())&&
    realpathSync(p)===p&&
    !p.startsWith(ROOT+'/')&&p!==ROOT,
  'owner evidence dir must be private, canonical and external to checkout');
  return p;
}
function readJson(file,max){
  const st=lstatSync(file);
  check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&
    st.size>1&&st.size<=max&&
    (st.mode&0o077)===0&&
    (typeof process.getuid!=='function'||st.uid===process.getuid()),
  'signoff evidence file missing or not private');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file)));}
  catch{deny('signoff evidence must be valid UTF-8 JSON');}
}
async function main(){
  const a=process.argv;
  check(a.length===6&&a[2]==='--sha'&&a[4]==='--evidence-dir'&&
    SHA40.test(a[3]||''),
  'use --sha EXACT_SHA --evidence-dir PRIVATE_DIR');
  // Only use the repository-pinned trust root; never accept --key or
  // --trust-path from CLI. Empty registry deliberately denies all releases.
  const registry=JSON.parse(readFileSync(TRUST,'utf8'));
  trustworthyRegistry(registry,Date.now());
  const sha=a[3],dir=privateDir(a[5]);
  const ociDir=privateDir(resolve(dir,'oci'));
  const securityDir=privateDir(resolve(dir,'security'));
  const approvalDir=privateDir(resolve(dir,'approval'));
  const receiptPath=resolve(ociDir,'sedeagro-images-'+sha+'.json');
  const bundlePath=resolve(ociDir,'sedeagro-images-'+sha+'.tar');
  const oci=await verifySignedRelease({sha,bundlePath,receiptPath});
  const security=verifySecuritySignatures({sha,dir:securityDir,
    ociReceiptPath:receiptPath});
  const context=verifiedReleaseRiskContext({
    sha,oci,security,receiptBytes:readFileSync(receiptPath)
  });
  const approval=readJson(resolve(approvalDir,'sedeagro-owner-approval-'+sha+'.json'),
    MAX_APPROVAL);
  const result=verifySecurityOwnerApproval({approval,registry,context});
  console.log(JSON.stringify(result));
  console.log('NOT AUTHORIZED: production/staging deploy and runtime TOCTOU are NOT certified.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED Security Owner risk approval: missing trusted human signing key, signed release evidence or valid detached signature');
    process.exitCode=2;
  });
}
