// 0R.22 — signed OCI image-only import for an authorized local Linux host.
// No containers, migrations, Compose up, proxy changes, or production GO.
// A human Ed25519 risk acceptance must be validated BEFORE Docker mutations.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectSignedImageCandidate}
  from './verify-production-image-admission.mjs';
import {verifyReceipt} from './oci-release-bundle.mjs';
import {validateImportedImage} from './ci-oci-import-rehearsal.mjs';
import {validateLocalDockerContext,inspectHostSignedImages}
  from './inspect-host-oci-images.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/,ID=/^sha256:[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
const RISK='HUMAN_SIGNED_OCI_IMAGE_RISK_REVIEW_NOT_DEPLOYED';
const HOST='HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED';
function deny(reason){throw new Error('SIGNED_HOST_OCI_IMPORT_BLOCKED: '+reason);}
function check(ok,reason){if(!ok)deny(reason);}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
const docker=args=>execFileSync('docker',args,{
  encoding:'utf8',timeout:args[0]==='image'&&args[1]==='load'?240000:20000,
  maxBuffer:64*1024,stdio:['ignore','pipe','pipe'],
  env:{PATH:process.env.PATH,HOME:process.env.HOME}
});
function privateDir(dir){
  check(typeof dir==='string'&&dir.length>0&&dir.length<4096,
    'private OCI release evidence directory required');
  const abs=resolve(dir),st=lstatSync(abs);
  check(st.isDirectory()&&!st.isSymbolicLink()&&
    (st.mode&0o077)===0&&
    (typeof process.getuid!=='function'||st.uid===process.getuid())&&
    realpathSync(abs)===abs&&!abs.startsWith(ROOT+'/')&&abs!==ROOT,
  'untrusted release evidence directory');
  return abs;
}
function privateArtifact(path,max,read=false){
  const st=lstatSync(path);
  check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&
    st.size>0&&st.size<=max&&
    (st.mode&0o077)===0&&
    (typeof process.getuid!=='function'||st.uid===process.getuid()),
  'untrusted signed OCI artifact');
  // A production Docker-save TAR may be gigabytes. Never buffer it in RAM;
  // the complete streaming digest/TAR parser below performs the actual check.
  return read?readFileSync(path):st.size;
}
function parseDocker(value){
  check(typeof value==='string'&&value.length>2&&value.length<64*1024,
    'invalid bounded Docker inspection response');
  try{return JSON.parse(value);}catch{deny('invalid Docker metadata JSON');}
}
function inspectedImage(execute,ref){
  return parseDocker(execute(['--context','default','image','inspect',
    '--format','{{json .}}',ref]));
}
function existingTag(execute,im,sha){
  // Image list is read-only; an unavailable Docker daemon must throw.
  const raw=execute(['--context','default','image','ls','--quiet',
    '--no-trunc','--filter','reference='+im.tag]);
  check(typeof raw==='string'&&raw.length<512,
    'invalid local image listing');
  if(raw.trim()==='')return false;
  // Reject a tag that points to DIFFERENT bytes, rather than silently
  // replacing a potentially deployed image during an "import-only".
  validateImportedImage(inspectedImage(execute,im.tag),im,sha);
  return true;
}
function verifyImages(execute,receipt,sha){
  for(let round=0;round<2;round++){
    for(const im of receipt.images){
      const fixed=inspectedImage(execute,im.config_id);
      const tagged=inspectedImage(execute,im.tag);
      validateImportedImage(fixed,im,sha);
      validateImportedImage(tagged,im,sha);
      check(fixed.Id===tagged.Id,
        'tag no longer refers to the imported immutable image ID');
    }
  }
}
export async function inspectHostSignedOciImport({
  sha,evidenceDir,mode='check-only',
  verifyRisk=inspectSignedImageCandidate,
  verifyArchive=verifyReceipt,
  inspectHost=inspectHostSignedImages,execute=docker
}={}){
  check(SHA.test(sha||'')&&['check-only','import-only'].includes(mode),
    'exact SHA and check-only/import-only operation required');
  const base=privateDir(evidenceDir);
  const ociDir=privateDir(join(base,'oci'));
  const receiptPath=join(ociDir,'sedeagro-images-'+sha+'.json');
  const bundlePath=join(ociDir,'sedeagro-images-'+sha+'.tar');
  // The high-trust risk gate comes before any Docker socket access.
  const human=await verifyRisk({sha,evidenceDir:base});
  check(human?.status===RISK&&human.head===sha&&
    human.security_owner_risk_accepted===true&&
    HEX.test(human.signer_key_id||'')&&
    HEX.test(human.oci_archive_sha256||'')&&
    HEX.test(human.oci_receipt_sha256||'')&&
    HEX.test(human.security_receipt_sha256||'')&&
    human.production_go===false&&human.staging_certified===false&&
    human.other_owners_approved===false&&
    human.time_of_use_certified===false&&
    human.images_loaded===false&&human.containers_created===false,
  'real independent human image-risk signature required before import');
  // Offline verifier parses the complete Docker-save TAR, compares every
  // layer, digest and size, and recomputes the exact receipt from bytes.
  const bytes=privateArtifact(receiptPath,65536,true);
  privateArtifact(bundlePath,8*1024*1024*1024);
  check(sha256(bytes)===human.oci_receipt_sha256,
    'signed receipt bytes drifted after human review');
  const result=await verifyArchive({sha,bundlePath,receiptPath});
  check(result?.status==='OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED'&&
    result.head===sha&&
    result.archive_sha256===human.oci_archive_sha256&&
    result.registry_digest_certified===false&&
    result.signed_provenance_certified===false,
  'verified OCI TAR contents differ from signed human risk context');
  let receipt;
  try{receipt=JSON.parse(bytes.toString('utf8'));}
  catch{deny('signed OCI receipt cannot be parsed');}
  check(receipt?.head===sha&&
    receipt.archive?.sha256===result.archive_sha256&&
    receipt.archive.name===basename(bundlePath)&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((im,i)=>
      im.service===SERVICES[i]&&ID.test(im.config_id||'')&&
      im.config_id===result.image_ids?.[im.service]&&
      im.tag==='sedeagro-'+im.service+'-rc:'+sha),
  'exact image IDs and archive must match signed OCI receipt');
  validateLocalDockerContext(execute);
  const already=Object.fromEntries(receipt.images.map(im=>
    [im.service,existingTag(execute,im,sha)]));
  const missing=SERVICES.filter(name=>!already[name]);
  // check-only must remain nonmutating even if all signed prerequisites pass.
  if(mode==='check-only'){
    return {
      status:'HOST_SIGNED_OCI_IMPORT_CHECKED_NOT_DEPLOYED',
      head:sha,archive_sha256:result.archive_sha256,
      image_ids:result.image_ids,missing_signed_images:missing,
      all_images_already_present:missing.length===0,
      security_owner_risk_accepted:true,
      image_load_performed:false,containers_created:false,
      containers_started:false,production_go:false
    };
  }
  // Caller grants IMPORT_ONLY intent for this SHA at the CLI boundary.
  // If any tag is present but wrong, the earlier existingTag gate throws.
  if(missing.length>0){
    try{execute(['--context','default','image','load','--input',bundlePath]);}
    catch{deny('signed OCI import failed; manually review partially loaded images');}
  }
  verifyImages(execute,receipt,sha);
  // Independent follow-up rechecks all SEVEN signed subjects against the
  // actual host image pair, including mutable tag drift and local Docker.
  const host=await inspectHost({sha,evidenceDir:base});
  check(host?.status===HOST&&host.head===sha&&
    host.oci_archive_sha256===human.oci_archive_sha256&&
    host.oci_receipt_sha256===human.oci_receipt_sha256&&
    host.security_receipt_sha256===human.security_receipt_sha256&&
    host.local_docker_context==='default'&&
    host.images_loaded_during_check===false&&
    host.containers_created===false&&
    host.image_pull_allowed===false&&
    host.build_allowed===false&&
    host.security_owner_approved===false&&
    host.release_go===false&&
    host.time_of_container_create_certified===false&&
    SERVICES.every(s=>host.inspected_image_ids?.[s]===result.image_ids[s]),
  'post-import signed OCI identity is not stable or verified');
  return {
    status:'HOST_SIGNED_OCI_IMAGES_IMPORTED_ONLY_NOT_DEPLOYED',
    head:sha,archive_sha256:result.archive_sha256,
    image_ids:result.image_ids,already_present:already,
    image_load_performed:missing.length>0,
    exact_local_ids_reverified:true,
    immutable_ids_not_tags:true,
    security_owner_risk_accepted:true,
    security_owner_deploy_approved:false,
    image_pull_allowed:false,image_build_allowed:false,
    containers_created:false,containers_started:false,
    migrations_executed:false,staging_certified:false,production_go:false,
    production_cutover_tested:false
  };
}
async function main(){
  const a=process.argv;
  check(a.length===8&&a[2]==='--sha'&&a[4]==='--evidence-dir'&&
    a[6]==='--mode'&&SHA.test(a[3]||'')&&
    ['check-only','import-only'].includes(a[7]),
  'usage --sha SHA40 --evidence-dir PRIVATE_DIR --mode check-only|import-only');
  const sha=a[3],mode=a[7];
  check(process.platform==='linux'&&
    !['CI','GITHUB_ACTIONS'].some(k=>process.env[k]==='true')&&
    !['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH',
      'DOCKER_CONFIG','COMPOSE_FILE','COMPOSE_ENV_FILES',
      'COMPOSE_PROJECT_NAME','COMPOSE_PROFILES'].some(k=>process.env[k]),
  'only an authorized local Linux operator may use host import');
  if(mode==='import-only')
    check(process.env.SEDEAGRO_OCI_IMPORT_APPROVAL==='IMPORT_ONLY:'+sha,
      'exact operator image-store-only import approval required');
  const git=args=>execFileSync('git',['-C',ROOT,...args],{
    encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']
  }).toString().trim();
  check(git(['symbolic-ref','--short','HEAD'])==='main'&&
    git(['rev-parse','HEAD'])===sha&&
    git(['rev-parse','refs/remotes/origin/main'])===sha&&
    git(['status','--porcelain','--untracked-files=no'])==='',
  'clean exact main and origin/main required');
  const result=await inspectHostSignedOciImport({
    sha,evidenceDir:a[5],mode
  });
  console.log(JSON.stringify(result));
  console.log('NOT DEPLOYED: images only; no services, DB, staging or production approval.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED signed host OCI import: invalid human risk, archive, Docker identity or explicit image-store-only intent');
    process.exitCode=2;
  });
}
