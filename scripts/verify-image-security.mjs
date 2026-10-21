// 0P.29 — fail-closed, attestable Syft/Trivy evidence for exact runtime images.
// A green CI verifies coverage, NOT an approved security posture or release.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attestationArgs, validateVerifiedAttestation } from './verify-oci-signed-provenance.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const HEAD=/^[a-f0-9]{40}$/, ID=/^sha256:[a-f0-9]{64}$/, SHA=/^[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'], SEVERITY=['UNKNOWN','LOW','MEDIUM','HIGH','CRITICAL'];
const MAX_SBOM=24*1024*1024, MAX_SCAN=24*1024*1024, MAX_RECEIPT=128*1024;
const REPO='FedesConsultora/SedeAgro', SCHEMA='sedeagro-image-security-v1';
const TOOL_VERSIONS={syft:'1.55.0',trivy:'0.76.1'};
const digest=x=>createHash('sha256').update(x).digest('hex');
function deny(reason){throw new Error('IMAGE_SECURITY_BLOCKED: '+reason);}
function check(ok,reason){if(!ok)deny(reason);}
function filename(service,sha,extension){return 'sedeagro-'+service+'-'+sha+'.'+extension;}

export function expectedSecurityFiles(sha){
  check(HEAD.test(sha||''),'exact SHA required');
  return SERVICES.flatMap(s=>[filename(s,sha,'spdx.json'),filename(s,sha,'trivy.json')])
    .concat('sedeagro-security-'+sha+'.json');
}
function readSafe(file,max){
  const st=lstatSync(file);
  check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&
    st.size>10&&st.size<=max&&(st.mode&0o002)===0,
  'unsafe or missing scanner output file');
  const bytes=readFileSync(file);
  check(bytes.length===st.size,'scanner output changed during read');
  let value;
  try{value=JSON.parse(bytes.toString('utf8'));}
  catch{deny('scanner output not JSON');}
  return{bytes,value,sha256:digest(bytes)};
}
function inDir(dir,name,max){
  const file=resolve(dir,name);
  check(dirname(file)===resolve(dir),'artifact path escape');
  return readSafe(file,max);
}
export function validateRuntimeImage(image,service,sha){
  const tag='sedeagro-'+service+'-rc:'+sha;
  check(SERVICES.includes(service)&&HEAD.test(sha||'')&&
    ID.test(image?.Id||'')&&image.Os==='linux'&&
    image.Architecture==='amd64'&&Array.isArray(image.RepoTags)&&
    image.RepoTags.includes(tag)&&
    image.Config?.Labels?.['org.opencontainers.image.revision']===sha&&
    Array.isArray(image.RootFS?.Layers)&&image.RootFS.Layers.length>0&&
    image.RootFS.Layers.every(id=>ID.test(id)),
  'image identity, platform or layers mismatch');
  if(service==='backend')check(Array.isArray(image.Config?.Env)&&
    image.Config.Env.includes('SEDEAGRO_BUILD_SHA='+sha),
  'backend source SHA mismatch');
  return {tag,image_id:image.Id,platform:'linux/amd64'};
}
export function validateSpdx(sbom,service,sha){
  const tag='sedeagro-'+service+'-rc:'+sha;
  check(sbom?.spdxVersion==='SPDX-2.3'&&sbom.SPDXID==='SPDXRef-DOCUMENT'&&
    sbom.dataLicense==='CC0-1.0'&&
    typeof sbom.name==='string'&&sbom.name.includes(tag)&&
    Array.isArray(sbom.packages)&&sbom.packages.length>=1&&
    sbom.packages.length<=200000&&Array.isArray(sbom.creationInfo?.creators)&&
    sbom.creationInfo.creators.some(x=>/^Tool: syft-/.test(x)),
  'Syft SPDX missing tool/source or package inventory');
  const ids=new Set();
  for(const pkg of sbom.packages){
    check(typeof pkg.SPDXID==='string'&&pkg.SPDXID.startsWith('SPDXRef-')&&
      !ids.has(pkg.SPDXID)&&typeof pkg.name==='string'&&
      pkg.name.length>0&&pkg.name.length<2000,
    'SBOM package identity missing or duplicated');
    ids.add(pkg.SPDXID);
  }
  check(Array.isArray(sbom.relationships)&&sbom.relationships.length>0,
    'SPDX package relationships missing');
  return sbom.packages.length;
}
export function assessTrivy(scan,service,sha){
  check(scan?.SchemaVersion===2&&
    scan.ArtifactName==='sedeagro-'+service+'-rc:'+sha&&
    scan.ArtifactType==='container_image'&&
    scan.Metadata&&typeof scan.Metadata==='object'&&
    Array.isArray(scan.Results)&&scan.Results.length>=1&&
    scan.Results.length<=2000,
  'Trivy scan coverage or exact image identity missing');
  const tally=Object.fromEntries(SEVERITY.map(s=>[s,0]));
  const fixed=Object.fromEntries(SEVERITY.map(s=>[s,0]));
  const seen=new Set();
  let findings=0;
  for(const result of scan.Results){
    check(typeof result.Target==='string'&&result.Target.length>0&&
      result.Target.length<4000&&Array.isArray(result.Vulnerabilities),
    'Trivy result target or vulnerabilities incomplete');
    for(const v of result.Vulnerabilities){
      check(++findings<=15000&&typeof v.VulnerabilityID==='string'&&
        v.VulnerabilityID.length>2&&v.VulnerabilityID.length<128&&
        typeof v.PkgName==='string'&&v.PkgName.length>0&&v.PkgName.length<1000&&
        typeof v.InstalledVersion==='string'&&v.InstalledVersion.length<1000&&
        SEVERITY.includes(v.Severity),
      'invalid or oversized Trivy vulnerability');
      const key=[result.Target,v.VulnerabilityID,v.PkgName,v.InstalledVersion].join('\u0000');
      check(!seen.has(key),'duplicate vulnerability identity');
      seen.add(key);
      tally[v.Severity]++;
      if(typeof v.FixedVersion==='string'&&v.FixedVersion.trim())fixed[v.Severity]++;
    }
  }
  return {findings,severities:tally,fixable_by_severity:fixed};
}
export function readSecurityDocuments({sha,dir}){
  check(HEAD.test(sha||'')&&typeof dir==='string'&&dir.length>0,
    'security document directory invalid');
  const docs={};
  for(const service of SERVICES){
    docs[service]={
      sbom:inDir(dir,filename(service,sha,'spdx.json'),MAX_SBOM),
      scan:inDir(dir,filename(service,sha,'trivy.json'),MAX_SCAN)
    };
  }
  return docs;
}
export function evaluateImageSecurity({sha,documents,imageIds}){
  check(HEAD.test(sha||'')&&documents&&imageIds&&
    Object.keys(imageIds).sort().join(',')===SERVICES.slice().sort().join(','),
  'both image identities required');
  const images=[];
  for(const service of SERVICES){
    const id=imageIds[service],doc=documents[service];
    check(ID.test(id||'')&&doc?.sbom&&doc?.scan&&
      SHA.test(doc.sbom.sha256||'')&&SHA.test(doc.scan.sha256||''),
    'image config ID or security report missing');
    const count=validateSpdx(doc.sbom.value,service,sha);
    const triage=assessTrivy(doc.scan.value,service,sha);
    const observedId=doc.scan.value.Metadata.ImageID;
    if(typeof observedId==='string'&&observedId.length>0)
      check(observedId===id,'Trivy image ID differs from Docker image ID');
    images.push({
      service,tag:'sedeagro-'+service+'-rc:'+sha,
      image_id:id,platform:'linux/amd64',
      sbom:{name:filename(service,sha,'spdx.json'),sha256:doc.sbom.sha256,packages:count},
      scan:{name:filename(service,sha,'trivy.json'),sha256:doc.scan.sha256,...triage}
    });
  }
  const aggregate=Object.fromEntries(SEVERITY.map(s=>[s,images.reduce(
    (v,x)=>v+x.scan.severities[s],0)]));
  const fixed=Object.fromEntries(SEVERITY.map(s=>[s,images.reduce(
    (v,x)=>v+x.scan.fixable_by_severity[s],0)]));
  const highCritical=aggregate.HIGH+aggregate.CRITICAL;
  const findings=images.reduce((x,y)=>x+y.scan.findings,0);
  return{
    schema:SCHEMA,head:sha,source_repository:REPO,tools:TOOL_VERSIONS,images,
    review:{
      findings,severities:aggregate,fixable_by_severity:fixed,
      high_critical_findings:highCritical,
      release_gate:highCritical>0?'BLOCKED_HIGH_OR_CRITICAL_SECURITY_FINDINGS':
        'EXTERNAL_SECURITY_REVIEW_REQUIRED',
      security_owner_review_required:true,release_go:false
    },
    limits:{scanner_database_freshness_certified:false,
      upstream_publisher_signatures_certified:false,
      staging_deployment_certified:false}
  };
}
export function createSecurityReceipt({sha,dir,docker}){
  const docs=readSecurityDocuments({sha,dir});
  const execute=docker||((args)=>execFileSync('docker',args,{
    encoding:'utf8',timeout:15000,maxBuffer:512*1024,stdio:['ignore','pipe','pipe']}));
  const ids={};
  for(const service of SERVICES){
    const tag='sedeagro-'+service+'-rc:'+sha;
    const text=execute(['image','inspect','--format','{{json .}}',tag]);
    check(typeof text==='string'&&text.length>0&&text.length<512*1024,
    'invalid image metadata');
    let image;
    try{image=JSON.parse(text);}catch{deny('Docker image metadata invalid');}
    ids[service]=validateRuntimeImage(image,service,sha).image_id;
  }
  const receipt=evaluateImageSecurity({sha,documents:docs,imageIds:ids});
  writeFileSync(resolve(dir,'sedeagro-security-'+sha+'.json'),
    JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
  return receipt;
}
export function verifySecurityReceipt({sha,dir,ociReceiptPath}){
  const docs=readSecurityDocuments({sha,dir});
  const raw=inDir(dir,'sedeagro-security-'+sha+'.json',MAX_RECEIPT);
  const report=raw.value;
  check(report?.schema===SCHEMA&&report.head===sha&&
    Array.isArray(report.images)&&report.images.length===2,
  'security receipt schema/source invalid');
  const ids=Object.fromEntries(report.images.map(x=>[x.service,x.image_id]));
  const verified=evaluateImageSecurity({sha,documents:docs,imageIds:ids});
  check(raw.bytes.equals(Buffer.from(JSON.stringify(verified)+'\n')),
    'security summary differs from complete scanned source files');
  if(ociReceiptPath){
    const oci=readSafe(ociReceiptPath,MAX_RECEIPT).value;
    check(oci.head===sha&&Array.isArray(oci.images)&&oci.images.length===2&&
      verified.images.every((image,i)=>oci.images[i].service===image.service&&
        oci.images[i].tag===image.tag&&oci.images[i].config_id===image.image_id),
    'security report image IDs differ from signed Docker-save receipt');
  }
  const subjects=expectedSecurityFiles(sha).map(name=>{
    const r=inDir(dir,name,name.endsWith('.spdx.json')?MAX_SBOM:
      name.endsWith('.trivy.json')?MAX_SCAN:MAX_RECEIPT);
    return{name,sha256:r.sha256};
  });
  return{status:'IMAGE_SECURITY_EVIDENCE_VERIFIED_RELEASE_NOT_CERTIFIED',
    head:sha,review:verified.review,images_verified:2,subjects,
    source_signed:false,release_certified:false};
}
export function verifySecuritySignatures({sha,dir,ociReceiptPath,execute}){
  const evidence=verifySecurityReceipt({sha,dir,ociReceiptPath});
  const run=execute||((args)=>execFileSync('gh',args,{
    encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,
    stdio:['ignore','pipe','pipe']}));
  for(const subject of evidence.subjects){
    const raw=run(attestationArgs(resolve(dir,subject.name),sha));
    check(typeof raw==='string'&&raw.length>0&&raw.length<4*1024*1024,
      'GitHub verified attestation output missing');
    validateVerifiedAttestation(raw,subject);
  }
  return{...evidence,status:'GITHUB_SIGNED_IMAGE_SECURITY_VERIFIED_RELEASE_NOT_CERTIFIED',
    source_signed:true};
}
function main(){
  const args=process.argv;
  check(args.length===10&&args[2]==='--mode'&&
    ['create','verify','verify-signed'].includes(args[3])&&
    args[4]==='--sha'&&args[6]==='--dir'&&args[8]==='--oci-receipt',
  'invalid command arguments');
  const mode=args[3],sha=args[5],dir=resolve(args[7]),
    ociReceiptPath=resolve(args[9]);
  check(HEAD.test(sha||'')&&process.env.CI==='true'&&
    process.env.GITHUB_ACTIONS==='true'&&
    process.env.GITHUB_REPOSITORY===REPO&&
    process.env.IMAGE_SHA===sha&&
    ['push','pull_request'].includes(process.env.GITHUB_EVENT_NAME),
  'only immutable GitHub CI release admitted');
  if(mode==='verify-signed')
    check(process.env.GITHUB_EVENT_NAME==='push'&&
      process.env.GITHUB_REF==='refs/heads/main',
    'signed admission is main-only');
  check(execFileSync('git',['rev-parse','HEAD'],
    {cwd:ROOT,encoding:'utf8',timeout:5000}).trim()===sha,
  'CI checkout differs from report SHA');
  const base=process.env.RUNNER_TEMP||'/no-runner-temp';
  check(dir===resolve(base,'sedeagro-security')&&
    ociReceiptPath===resolve(base,'sedeagro-oci','sedeagro-images-'+sha+'.json'),
  'untrusted report or Docker receipt directory');
  const result=mode==='create'?createSecurityReceipt({sha,dir}):
    mode==='verify'?verifySecurityReceipt({sha,dir,ociReceiptPath}):
      verifySecuritySignatures({sha,dir,ociReceiptPath});
  console.log(JSON.stringify({status:mode==='create'?
    'IMAGE_SECURITY_REPORTS_GENERATED_RELEASE_NOT_CERTIFIED':result.status,
    head:sha,review:result.review,verified_subjects:mode==='verify-signed'?5:0,
    release_certified:false}));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try{main();}catch{
    // Never log secrets, raw Docker inspect env or individual vulnerabilities.
    console.error('BLOCKED image security: missing evidence, stale identity or invalid signature');
    process.exitCode=2;
  }
}
