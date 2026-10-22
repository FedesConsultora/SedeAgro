// 0P.40: signed local host image identity + secret-free production Compose preview.
// READ ONLY: no Compose up/create/run, no Docker image load/build/pull, no GO.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectHostSignedImages} from './inspect-host-oci-images.mjs';
import {validateProductionOverlay,withSyntheticComposeFiles}
  from './ci-oci-production-overlay.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{40}$/;
const ID=/^sha256:[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
function deny(reason){throw new Error('HOST_OCI_COMPOSE_PREVIEW_BLOCKED: '+reason);}
function check(ok,reason){if(!ok)deny(reason);}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function parse(raw,reason){
  check(typeof raw==='string'&&raw.length>2&&raw.length<512*1024,
    reason+' missing or oversized');
  try{return JSON.parse(raw);}catch{deny(reason+' invalid JSON');}
}
function secureReceipt(sha,dir){
  const path=join(resolve(dir),'oci','sedeagro-images-'+sha+'.json');
  const st=lstatSync(path);
  check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&
    st.size>10&&st.size<65536,'signed receipt must be a bounded private regular file');
  const bytes=readFileSync(path);
  check(bytes.length===st.size,'signed receipt changed during read');
  return {receipt:parse(bytes.toString('utf8'),'signed receipt'),digest:sha256(bytes)};
}
function composeCommand(args,env){
  return execFileSync('docker',args,{
    encoding:'utf8',timeout:15000,maxBuffer:512*1024,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,...env},
    stdio:['ignore','pipe','pipe']
  });
}
function syntheticEnv(sha){
  // Compose is rendered against synthetic files outside the checkout.
  // Do NOT inherit .env / backend/.env or any production credentials.
  return {
    COMPOSE_DISABLE_ENV_FILE:'1',COMPOSE_PROFILES:'',
    SEDEAGRO_RELEASE_SHA:sha,
    SEDEAGRO_OCI_BACKEND_IMAGE:'sedeagro-backend-rc:'+sha,
    SEDEAGRO_OCI_FRONTEND_IMAGE:'sedeagro-frontend-rc:'+sha,
    POSTGRES_PASSWORD:'DISPOSABLE_REVIEW_ONLY',
    APP_DB_PASSWORD:'DISPOSABLE_REVIEW_ONLY'
  };
}
export async function previewSignedHostCompose({
  sha,evidenceDir,inspect=inspectHostSignedImages,execute=composeCommand
}={}){
  check(SHA.test(sha||'')&&typeof evidenceDir==='string'&&evidenceDir.length>0&&
    typeof inspect==='function'&&typeof execute==='function',
  'exact release SHA, evidence directory and independent inspector required');
  // The real inspector checks signed 7-subject provenance, local Docker socket,
  // immutable config/layer pairs, and refuses any Security Owner GO inference.
  const verified=await inspect({sha,evidenceDir});
  check(verified?.status==='HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED'&&
    verified.head===sha&&
    /^[a-f0-9]{64}$/.test(verified.oci_archive_sha256||'')&&
    /^[a-f0-9]{64}$/.test(verified.oci_receipt_sha256||'')&&
    /^[a-f0-9]{64}$/.test(verified.security_receipt_sha256||'')&&
    verified.local_docker_context==='default'&&
    verified.signed_security_inventory_verified===true&&
    verified.images_loaded_during_check===false&&
    verified.containers_created===false&&
    verified.image_pull_allowed===false&&verified.build_allowed===false&&
    verified.security_owner_approved===false&&verified.release_go===false&&
    verified.time_of_container_create_certified===false&&
    verified.production_deploy_certified===false&&
    SERVICES.every(x=>ID.test(verified.inspected_image_ids?.[x]||''))&&
    verified.inspected_image_ids.backend!==verified.inspected_image_ids.frontend,
  'prior signed seven-subject host admission required (NOT a production GO)');
  const {receipt,digest}=secureReceipt(sha,evidenceDir);
  check(digest===verified.oci_receipt_sha256&&receipt.head===sha&&
    receipt.archive?.sha256===verified.oci_archive_sha256&&
    receipt.archive?.name==='sedeagro-images-'+sha+'.tar'&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((im,i)=>im.service===SERVICES[i]&&
      im.config_id===verified.inspected_image_ids[im.service]&&
      im.tag==='sedeagro-'+im.service+'-rc:'+sha),
  'receipt modified after signature checks or mismatched local immutable IDs');

  // ONLY docker compose config on a synthetic copy. Sanitized env, no
  // production .env, no service mutation, no actual secrets in output.
  const args=['config','--no-env-resolution','--format','json'];
  const env=syntheticEnv(sha);
  const [base,candidate]=withSyntheticComposeFiles(({prod,overlay})=>[
    parse(execute(['--context','default','compose','-f',prod,...args],env),
      'base Compose config'),
    parse(execute(['--context','default','compose','-f',prod,'-f',overlay,...args],env),
      'signed OCI Compose config')
  ]);
  const ids=validateProductionOverlay(base,candidate,receipt,sha);
  check(SERVICES.every(s=>ids[s]===verified.inspected_image_ids[s]),
    'rendered Compose services do not match signed local Docker IDs');
  return {
    status:'HOST_SIGNED_OCI_COMPOSE_PARITY_READONLY_NOT_DEPLOYED',
    head:sha,oci_archive_sha256:verified.oci_archive_sha256,
    oci_receipt_sha256:digest,
    inspected_image_ids:ids,compose_project:'sedeagro',
    preview_uses_synthetic_files:true,
    production_env_read:false,live_compose_config_used:false,
    image_pull_allowed:false,build_allowed:false,
    containers_created:false,containers_started:false,
    security_owner_approved:false,release_go:false,
    time_of_container_create_certified:false,
    staging_deploy_certified:false,production_deploy_certified:false
  };
}
async function main(){
  const args=process.argv;
  check(args.length===6&&args[2]==='--sha'&&args[4]==='--evidence-dir',
    'only --sha SHA40 --evidence-dir PRIVATE_DIR are supported');
  const sha=args[3];
  check(SHA.test(sha||'')&&process.platform==='linux'&&
    !['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH',
      'COMPOSE_FILE','COMPOSE_ENV_FILES'].some(k=>process.env[k]),
    'local Linux host without Docker or Compose overrides required');
  const git=a=>execFileSync('git',['-C',ROOT,...a],{
    encoding:'utf8',timeout:5000,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe']
  }).trim();
  check(git(['symbolic-ref','--short','HEAD'])==='main'&&
    git(['rev-parse','HEAD'])===sha&&
    git(['rev-parse','refs/remotes/origin/main'])===sha&&
    git(['status','--porcelain','--untracked-files=no'])==='',
    'exact clean main and origin/main required before signed host inspection');
  const report=await previewSignedHostCompose({sha,evidenceDir:args[5]});
  console.log(JSON.stringify(report));
  console.log('NOT AUTHORIZED: no Security Owner GO, deploy, migration or future image-use proof.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED host OCI Compose preview: invalid signed host images or topology');
    process.exitCode=2;
  });
}
