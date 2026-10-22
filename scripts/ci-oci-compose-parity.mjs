// 0P.34: verify exactly how a networkless, image-only Compose consumer would
// resolve the two signed OCI configs on a disposable CI Docker store.
// NEVER calls compose up, run, start, pull, build, load or any daemon mutation.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReceipt } from './oci-release-bundle.mjs';
import { validateImportedImage } from './ci-oci-import-rehearsal.mjs';

const HEAD=/^[a-f0-9]{40}$/;
const ID=/^sha256:[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const CONFIG=resolve(ROOT,'docker-compose.oci-review.yml');
function deny(reason){throw new Error('OCI_COMPOSE_PARITY_BLOCKED: '+reason);}
function check(ok,reason){if(!ok)deny(reason);}

const command=(args,env={})=>execFileSync('docker',args,{
  encoding:'utf8',timeout:15000,maxBuffer:512*1024,
  env:{...process.env,...env},stdio:['ignore','pipe','pipe']
});

export function validateReviewCompose(plan,receipt,sha){
  check(HEAD.test(sha||'')&&receipt?.head===sha&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((x,i)=>x.service===SERVICES[i]&&
      x.tag==='sedeagro-'+x.service+'-rc:'+sha&&ID.test(x.config_id||'')),
  'signed OCI receipt identity invalid');
  check(plan&&typeof plan==='object'&&!Array.isArray(plan)&&
    Object.keys(plan).sort().join(',')==='name,services'&&
    plan.name==='sedeagro-oci-review'&&plan.services&&
    Object.keys(plan.services).sort().join(',')==='backend,frontend',
  'Compose must contain only two isolated review services');
  for(const [index,service] of SERVICES.entries()){
    const candidate=plan.services[service];
    check(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&
      Object.keys(candidate).sort().join(',')===
        'command,entrypoint,image,network_mode,pull_policy,read_only'&&
      candidate.image===receipt.images[index].tag&&
      candidate.pull_policy==='never'&&candidate.network_mode==='none'&&
      candidate.read_only===true&&
      JSON.stringify(candidate.entrypoint)===
        JSON.stringify(service==='backend'?['node']:['nginx'])&&
      JSON.stringify(candidate.command)===
        JSON.stringify(service==='backend'?['--version']:['-v']),
    'review service must be immutable-tag, no-build, no-pull, networkless and read-only');
  }
  return Object.fromEntries(receipt.images.map(im=>[im.service,im.config_id]));
}

function parseSafeJson(value){
  check(typeof value==='string'&&value.length>2&&value.length<512*1024,
    'missing or oversized Docker verification output');
  try{return JSON.parse(value);}catch{deny('Docker verification result is not JSON');}
}

export async function inspectImportedCompose({
  sha,receiptPath,bundlePath,composePath=CONFIG,
  execute=command,verify=verifyReceipt
}={}){
  check(HEAD.test(sha||'')&&typeof receiptPath==='string'&&
    typeof bundlePath==='string'&&resolve(composePath)===CONFIG,
  'only exact SHA and reviewed non-production Compose template admitted');
  const verified=await verify({sha,bundlePath,receiptPath});
  check(verified?.head===sha&&
    verified.status==='OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED'&&
    /^[a-f0-9]{64}$/.test(verified.archive_sha256||'')&&
    verified.registry_digest_certified===false&&
    verified.signed_provenance_certified===false,
  'complete archive must be checked before daemon inspection');
  const receipt=parseSafeJson(readFileSync(receiptPath,'utf8'));
  check(receipt.archive?.sha256===verified.archive_sha256&&
    receipt.archive?.name==='sedeagro-images-'+sha+'.tar'&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every(x=>verified.image_ids?.[x.service]===x.config_id),
  'receipt differs from the independently verified full OCI TAR');
  const env={
    SEDEAGRO_OCI_BACKEND_IMAGE:'sedeagro-backend-rc:'+sha,
    SEDEAGRO_OCI_FRONTEND_IMAGE:'sedeagro-frontend-rc:'+sha
  };
  const rendered=parseSafeJson(execute([
    'compose','-f',CONFIG,'config','--format','json'
  ],env));
  const ids=validateReviewCompose(rendered,receipt,sha);
  const inspect=(tag)=>parseSafeJson(execute([
    'image','inspect','--format','{{json .}}',tag
  ]));
  for(const im of receipt.images)
    validateImportedImage(inspect(im.tag),im,sha);
  // A retag between initial inspection and the last read must fail, though
  // this cannot eliminate TOCTOU between review and an eventual container
  // create. No container create exists here, and production stays blocked.
  for(const im of receipt.images)
    validateImportedImage(inspect(im.tag),im,sha);
  return {
    status:'CI_OCI_IMAGE_ONLY_COMPOSE_REVIEW_NOT_DEPLOYED',
    head:sha,archive_sha256:verified.archive_sha256,
    imported_images:ids,compose_project:'sedeagro-oci-review',
    image_rebuild_allowed:false,image_pull_allowed:false,
    container_started:false,network_created:false,
    signed_release_approval:false,production_deploy_certified:false,
    time_of_use_certified:false
  };
}
async function main(){
  const a=process.argv;
  check(a.length===8&&a[2]==='--sha'&&a[4]==='--bundle'&&
    a[6]==='--receipt',
  'expected --sha SHA40 --bundle TAR --receipt JSON');
  const sha=a[3],bundlePath=resolve(a[5]),receiptPath=resolve(a[7]);
  check(process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'&&
    process.env.GITHUB_EVENT_NAME==='push'&&
    process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_REPOSITORY==='FedesConsultora/SedeAgro'&&
    process.env.IMAGE_SHA===sha&&HEAD.test(sha),
  'main-only exact SHA disposable CI receiver required');
  const head=execFileSync('git',['rev-parse','HEAD'],{
    cwd:ROOT,encoding:'utf8',timeout:5000
  }).trim();
  const expectedDir=resolve(process.env.RUNNER_TEMP||'/invalid',
    'sedeagro-oci');
  check(head===sha&&dirname(bundlePath)===expectedDir&&
    dirname(receiptPath)===expectedDir&&
    basename(bundlePath)==='sedeagro-images-'+sha+'.tar'&&
    basename(receiptPath)==='sedeagro-images-'+sha+'.json',
  'signed receiver or artifact location differs from immutable SHA');
  const report=await inspectImportedCompose({sha,bundlePath,receiptPath});
  console.log(JSON.stringify(report));
  console.log('NOT CERTIFIED: Security Owner approval, actual compose up, staging or production.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED OCI Compose parity: invalid receipt, image identity, or non-production preview');
    process.exitCode=2;
  });
}
