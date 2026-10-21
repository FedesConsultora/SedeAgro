import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  expectedSecurityFiles,validateRuntimeImage,validateSpdx,assessTrivy,
  evaluateImageSecurity,createSecurityReceipt,verifySecurityReceipt,
  verifySecuritySignatures
} from '../verify-image-security.mjs';

const sha='a'.repeat(40),services=['backend','frontend'];
const id=s=>'sha256:'+(s==='backend'?'b':'c').repeat(64);
const tag=s=>'sedeagro-'+s+'-rc:'+sha;
const hash=x=>createHash('sha256').update(x).digest('hex');
const spdx=s=>({
  spdxVersion:'SPDX-2.3',SPDXID:'SPDXRef-DOCUMENT',
  dataLicense:'CC0-1.0',name:tag(s),
  creationInfo:{creators:['Tool: syft-1.55.0']},
  packages:[{SPDXID:'SPDXRef-Package-1',name:s==='backend'?'nodejs':'nginx'}],
  relationships:[{spdxElementId:'SPDXRef-DOCUMENT',relatedSpdxElement:'SPDXRef-Package-1',
    relationshipType:'DESCRIBES'}]
});
const vulnerability=(severity,fixable,override={})=>({
  VulnerabilityID:'CVE-2026-12345',PkgName:'nginx',
  InstalledVersion:'1.27.0',Severity:severity,...(fixable?{FixedVersion:'1.28.0'}:{}),
  ...override
});
const trivy=(s,{vulns=[]}={})=>({
  SchemaVersion:2,ArtifactName:tag(s),ArtifactType:'container_image',
  Metadata:{ImageID:id(s),OS:{Family:'alpine',Name:'3.22'}},
  Results:[{Target:'alpine:3.22',Class:'os-pkgs',Type:'alpine',
    Vulnerabilities:vulns}]
});
const image=s=>({
  Id:id(s),Os:'linux',Architecture:'amd64',RepoTags:[tag(s)],
  Config:{Labels:{'org.opencontainers.image.revision':sha},
    Env:s==='backend'?['SEDEAGRO_BUILD_SHA='+sha]:[]},
  RootFS:{Layers:['sha256:'+'e'.repeat(64)]}
});
const subject=s=>s==='backend'?id('backend'):id('frontend');
const makeDocs=(a={},b={})=>Object.fromEntries(services.map(s=>{
  const sbom=spdx(s),scan=trivy(s,s==='backend'?a:b);
  return[s,{sbom:{value:sbom,sha256:hash(JSON.stringify(sbom))},
    scan:{value:scan,sha256:hash(JSON.stringify(scan))}}];
}));
function fixture(t,{backend={},frontend={}}={}){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-security-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const s of services){
    writeFileSync(join(dir,'sedeagro-'+s+'-'+sha+'.spdx.json'),
      JSON.stringify(spdx(s))+'\n');
    writeFileSync(join(dir,'sedeagro-'+s+'-'+sha+'.trivy.json'),
      JSON.stringify(trivy(s,s==='backend'?backend:frontend))+'\n');
  }
  const oci=join(dir,'oci-receipt.json');
  writeFileSync(oci,JSON.stringify({head:sha,images:services.map(s=>({
    service:s,config_id:id(s),tag:tag(s)
  }))}));
  return{dir,oci};
}
const fakeDocker=args=>{
  assert.deepEqual(args.slice(0,4),['image','inspect','--format','{{json .}}']);
  return JSON.stringify(image(args[4].includes('backend')?'backend':'frontend'));
};
function signResult(name,digest){
  return JSON.stringify([{verificationResult:{
    statement:{predicateType:'https://slsa.dev/provenance/v1',
      subject:[{name,digest:{sha256:digest}}]},
    signature:{certificate:{identity:'github-oidc'}},
    verifiedTimestamps:[{type:'transparency-log'}]
  }}]);
}

test('exact five security subject names protect both images',()=>{
  assert.deepEqual(expectedSecurityFiles(sha),[
    'sedeagro-backend-'+sha+'.spdx.json',
    'sedeagro-backend-'+sha+'.trivy.json',
    'sedeagro-frontend-'+sha+'.spdx.json',
    'sedeagro-frontend-'+sha+'.trivy.json',
    'sedeagro-security-'+sha+'.json'
  ]);
  assert.throws(()=>expectedSecurityFiles('deadbeef'),/IMAGE_SECURITY_BLOCKED/);
});
test('rejects wrong image config id, tag, architecture and revision before receipt write',()=>{
  for(const bad of [
    {...image('backend'),Id:'sha256:invalid'},
    {...image('backend'),RepoTags:[]},
    {...image('backend'),Architecture:'arm64'},
    {...image('backend'),Config:{Labels:{},Env:[]}},
    {...image('backend'),RootFS:{Layers:[]}},
  ])assert.throws(()=>validateRuntimeImage(bad,'backend',sha),/IMAGE_SECURITY_BLOCKED/);
  assert.equal(validateRuntimeImage(image('backend'),'backend',sha).image_id,id('backend'));
});
test('refuses SPDX missing name/source syft creator, package IDs or relationships',()=>{
  const valid=spdx('frontend');
  assert.equal(validateSpdx(valid,'frontend',sha),1);
  for(const bad of [
    {...valid,name:'other-image'},
    {...valid,creationInfo:{creators:['Tool: stranger']}},
    {...valid,packages:[]},
    {...valid,packages:[valid.packages[0],valid.packages[0]]},
    {...valid,relationships:[]}
  ])assert.throws(()=>validateSpdx(bad,'frontend',sha),/IMAGE_SECURITY_BLOCKED/);
});
test('risk counting preserves severity and fixed status without hiding CRITICAL',()=>{
  const v=[vulnerability('CRITICAL',true),
    vulnerability('HIGH',false,{VulnerabilityID:'CVE-2026-99999'})];
  const a=assessTrivy(trivy('frontend',{vulns:v}),'frontend',sha);
  assert.equal(a.findings,2);
  assert.equal(a.severities.CRITICAL,1);
  assert.equal(a.fixable_by_severity.CRITICAL,1);
  assert.equal(a.severities.HIGH,1);
  assert.equal(a.fixable_by_severity.HIGH,0);
});
test('Trivy wrong image, incomplete results and duplicated findings fail closed',()=>{
  const base=trivy('backend',{vulns:[vulnerability('HIGH',true)]});
  for(const bad of [
    {...base,ArtifactName:'sedeagro-backend-rc:'+'c'.repeat(40)},
    {...base,Results:[]},
    {...base,Results:[{Target:'alpine:3.22'}]},
    {...base,Results:[{Target:'alpine:3.22',Vulnerabilities:[
      vulnerability('HIGH',true),vulnerability('HIGH',true)]}]},
    {...base,Results:[{Target:'alpine:3.22',Vulnerabilities:[
      vulnerability('MEDIUM',false,{Severity:'URGENT'})]}]}
  ])assert.throws(()=>assessTrivy(bad,'backend',sha),/IMAGE_SECURITY_BLOCKED/);
});
test('summary classifies HIGH/CRITICAL as release blocked but CI evidence remains distinguishable',()=>{
  const risk=evaluateImageSecurity({sha,documents:makeDocs({vulns:[
    vulnerability('HIGH',false)]},{vulns:[vulnerability('CRITICAL',true)]}),
    imageIds:{backend:id('backend'),frontend:id('frontend')}});
  assert.equal(risk.review.severities.CRITICAL,1);
  assert.equal(risk.review.severities.HIGH,1);
  assert.equal(risk.review.release_gate,'BLOCKED_HIGH_OR_CRITICAL_SECURITY_FINDINGS');
  assert.equal(risk.review.release_go,false);
  assert.equal(risk.limits.scanner_database_freshness_certified,false);
  assert.equal(evaluateImageSecurity({sha,documents:makeDocs(),
    imageIds:{backend:id('backend'),frontend:id('frontend')}})
    .review.release_gate,'EXTERNAL_SECURITY_REVIEW_REQUIRED');
});
test('real file create/verify binds report hashes to image config IDs and OCI receipt',t=>{
  const f=fixture(t,{frontend:{vulns:[vulnerability('CRITICAL',true)]}});
  const r=createSecurityReceipt({sha,dir:f.dir,docker:fakeDocker});
  assert.equal(r.images.length,2);
  assert.equal(r.images[0].sbom.packages,1);
  assert.equal(r.review.release_go,false);
  const verified=verifySecurityReceipt({sha,dir:f.dir,ociReceiptPath:f.oci});
  assert.equal(verified.images_verified,2);
  assert.equal(verified.subjects.length,5);
  assert.equal(verified.review.high_critical_findings,1);
  assert.equal(verified.source_signed,false);
});
test('one altered SBOM, Trivy scan or report summary cannot pass receipt verify',t=>{
  const f=fixture(t);
  createSecurityReceipt({sha,dir:f.dir,docker:fakeDocker});
  const first=join(f.dir,'sedeagro-backend-'+sha+'.spdx.json');
  const original=readFileSync(first,'utf8');
  writeFileSync(first,original.replace('nodejs','nodejx'));
  assert.throws(()=>verifySecurityReceipt({sha,dir:f.dir,ociReceiptPath:f.oci}),
    /IMAGE_SECURITY_BLOCKED/);
  writeFileSync(first,original);
  const scan=join(f.dir,'sedeagro-frontend-'+sha+'.trivy.json');
  writeFileSync(scan,JSON.stringify(trivy('frontend',{vulns:[
    vulnerability('HIGH',true)]})));
  assert.throws(()=>verifySecurityReceipt({sha,dir:f.dir,ociReceiptPath:f.oci}),
    /IMAGE_SECURITY_BLOCKED/);
});
test('mismatched OCI config ID blocks acceptance even with perfectly consistent reports',t=>{
  const f=fixture(t);
  createSecurityReceipt({sha,dir:f.dir,docker:fakeDocker});
  const bad=JSON.parse(readFileSync(f.oci,'utf8'));
  bad.images[1].config_id='sha256:'+'f'.repeat(64);
  writeFileSync(f.oci,JSON.stringify(bad));
  assert.throws(()=>verifySecurityReceipt({sha,dir:f.dir,ociReceiptPath:f.oci}),
    /IMAGE_SECURITY_BLOCKED/);
});
test('symlinked or missing scan artifacts block before Docker or GitHub signatures',t=>{
  const f=fixture(t);
  const p=join(f.dir,'sedeagro-backend-'+sha+'.trivy.json');
  const bytes=readFileSync(p);
  rmSync(p);
  const outside=join(f.dir,'elsewhere');
  writeFileSync(outside,bytes);
  symlinkSync(outside,p);
  let called=0;
  assert.throws(()=>createSecurityReceipt({sha,dir:f.dir,docker:()=>{called++;return'';}}),
    /IMAGE_SECURITY_BLOCKED/);
  assert.equal(called,0);
});
test('each of five subjects must have verified GitHub exact-name+hash signature',t=>{
  const f=fixture(t);
  createSecurityReceipt({sha,dir:f.dir,docker:fakeDocker});
  const calls=[];
  const approved=verifySecuritySignatures({sha,dir:f.dir,ociReceiptPath:f.oci,
    execute:args=>{
      calls.push(args);
      assert.ok(args.includes('--deny-self-hosted-runners'));
      assert.ok(args.includes('--source-digest'));
      assert.ok(args.includes(sha));
      const bytes=readFileSync(args[2]);
      const name=args[2].split('/').at(-1);
      return signResult(name,hash(bytes));
    }});
  assert.equal(approved.source_signed,true);
  assert.equal(calls.length,5);
  assert.equal(approved.status,'GITHUB_SIGNED_IMAGE_SECURITY_VERIFIED_RELEASE_NOT_CERTIFIED');
});
test('forged or absent signature on any SBOM/report is rejected',t=>{
  const f=fixture(t);createSecurityReceipt({sha,dir:f.dir,docker:fakeDocker});
  for(const execute of [
    ()=>{throw Error('signature rejected');},
    ()=>signResult('other-file.json','a'.repeat(64)),
    ()=>JSON.stringify([{verificationResult:{statement:{subject:[]}}}])
  ])assert.throws(()=>verifySecuritySignatures({sha,dir:f.dir,
    ociReceiptPath:f.oci,execute}));
});
test('CLI blocks non-GitHub or PR-only signed inspection and never leaks secrets',()=>{
  const cli=fileURLToPath(new URL('../verify-image-security.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[cli,'--mode','verify-signed','--sha',sha,
    '--dir','/tmp/elsewhere','--oci-receipt','/tmp/other'],{
    encoding:'utf8',env:{...process.env,CI:'false',
      GITHUB_ACTIONS:'false',JWT_SECRET:'PRIVATE_SCAN_SECRET'},timeout:5000
  });
  assert.equal(r.status,2);
  assert.match(r.stderr,/BLOCKED image security/);
  assert.doesNotMatch(r.stdout+r.stderr,/PRIVATE_SCAN_SECRET/);
});
test('workflow scans exact backend/frontend built images before export and signs reports on main',()=>{
  const wf=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const producer=wf.split('  production-images:')[1]?.split('  dependency-security:')[0]||'';
  const signer=wf.split('  attest-oci-bundle:')[1]?.split('  offline-image-import:')[0]||'';
  const fresh=wf.split('  offline-image-import:')[1]||'';
  assert.match(producer,/anchore\/sbom-action@e22c389904149dbc22b58101806040fa8d37a610/);
  assert.match(producer,/aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
  for(const name of ['backend','frontend']){
    assert.match(producer,new RegExp('sedeagro-'+name+'-rc:'));
    assert.match(producer,new RegExp('sedeagro-'+name+'-\\$\\{\\{ env.IMAGE_SHA \\}\\}.spdx.json'));
  }
  assert.match(producer,/scripts\/verify-image-security\.mjs --mode create/);
  assert.match(producer,/scripts\/verify-image-security\.mjs --mode verify/);
  assert.match(signer,/sedeagro-security-\$\{\{ github.sha \}\}\.json/);
  assert.match(fresh,/scripts\/verify-image-security\.mjs --mode verify-signed/);
  assert.ok(fresh.indexOf('verify-signed')<fresh.indexOf('ci-oci-import-rehearsal.mjs'));
  assert.doesNotMatch(producer,/docker push|docker compose up/);
});
