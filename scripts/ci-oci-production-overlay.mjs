// 0P.35 — read-only dry-run of EXISTING production Compose with a no-build
// OCI image override. This is NOT a deployment or release admission.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImportedCompose } from './ci-oci-compose-parity.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PROD=resolve(ROOT,'docker-compose.yml');
const OVERLAY=resolve(ROOT,'docker-compose.oci-production-override.yml');
const SHA40=/^[a-f0-9]{40}$/;
const ID=/^sha256:[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
const DB='postgis/postgis:16-3.4@sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5';
const REDIS='redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
function deny(s){throw new Error('OCI_PRODUCTION_OVERLAY_BLOCKED: '+s);}
function check(v,s){if(!v)deny(s);}
const envFor=sha=>({
  COMPOSE_DISABLE_ENV_FILE:'1',COMPOSE_PROFILES:'',
  SEDEAGRO_RELEASE_SHA:sha,
  SEDEAGRO_OCI_BACKEND_IMAGE:'sedeagro-backend-rc:'+sha,
  SEDEAGRO_OCI_FRONTEND_IMAGE:'sedeagro-frontend-rc:'+sha,
  POSTGRES_PASSWORD:'DISPOSABLE_REVIEW_ONLY',
  APP_DB_PASSWORD:'DISPOSABLE_REVIEW_ONLY'
});
const command=(args,env)=>execFileSync('docker',args,{
  encoding:'utf8',timeout:15000,maxBuffer:512*1024,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,...env},
  stdio:['ignore','pipe','pipe']
});
function parse(value){
  check(typeof value==='string'&&value.length>2&&value.length<512*1024,
    'Docker config output missing or too large');
  try{return JSON.parse(value);}catch{deny('invalid Docker config JSON');}
}
function sorted(x){return Object.keys(x||{}).sort().join(',');}
export function validateProductionOverlay(base,overlay,receipt,sha){
  check(SHA40.test(sha||'')&&receipt?.head===sha&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((im,i)=>im?.service===SERVICES[i]&&
      im.tag==='sedeagro-'+im.service+'-rc:'+sha&&
      ID.test(im.config_id||'')),
  'exact SHA and two trusted image receipts required');
  check(base?.name==='sedeagro'&&
    sorted(base.services)==='backend,db,frontend,redis'&&
    sorted(base.volumes)==='sedeagro_db,sedeagro_redis'&&
    sorted(base.networks)==='fedes-net,sedeagro_internal'&&
    base.networks['fedes-net']?.external===true&&
    base.services.db?.image===DB&&base.services.redis?.image===REDIS,
  'unexpected production service, network, volume or base image');
  check(SERVICES.every(s=>
    base.services[s]?.build&&typeof base.services[s].build==='object'&&
    !base.services[s].image&&
    !base.services[s].ports&&
    !base.services[s].privileged&&
    !base.services[s].pull_policy),
  'unreviewed source Compose already selects runtime images or has unsafe ports');
  check(!base.services.db?.ports&&!base.services.redis?.ports&&
    !base.services.db?.privileged&&!base.services.redis?.privileged,
  'base dependency changed into a public or privileged service');
  const expected=structuredClone(base);
  for(const [i,service] of SERVICES.entries()){
    delete expected.services[service].build;
    expected.services[service].image=receipt.images[i].tag;
    expected.services[service].pull_policy='never';
  }
  check(isDeepStrictEqual(overlay,expected),
    'OCI override must ONLY remove build, add immutable signed SHA images and disable pulls');
  return Object.fromEntries(receipt.images.map(x=>[x.service,x.config_id]));
}

// Docker Compose's config validator stats required env_file even with
// --no-env-resolution. Never read/copy any real backend/.env: mirror only
// committed YAML bytes under private disposable temp with a synthetic stub.
export function withSyntheticComposeFiles(run){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-oci-prod-preview-'));
  try{
    const backend=join(dir,'backend');
    mkdirSync(backend,{mode:0o700});
    writeFileSync(join(backend,'.env'),'NODE_ENV=ci-oci-review-only\n',
      {mode:0o600,flag:'wx'});
    const prod=join(dir,'docker-compose.yml');
    const overlay=join(dir,'docker-compose.oci-production-override.yml');
    writeFileSync(prod,readFileSync(PROD),{mode:0o600,flag:'wx'});
    writeFileSync(overlay,readFileSync(OVERLAY),{mode:0o600,flag:'wx'});
    return run({prod,overlay});
  }finally{rmSync(dir,{recursive:true,force:true});}
}

export async function inspectProductionOverlay({
  sha,bundlePath,receiptPath,execute=command,
  review=inspectImportedCompose
}={}){
  check(SHA40.test(sha||'')&&
    typeof bundlePath==='string'&&typeof receiptPath==='string',
  'exact SHA and reviewed OCI artifacts required');
  // Reuses the independently tested complete TAR verifier plus Docker image
  // config/rootfs double-inspection, before reading production configuration.
  const verified=await review({sha,bundlePath,receiptPath});
  check(verified?.status==='CI_OCI_IMAGE_ONLY_COMPOSE_REVIEW_NOT_DEPLOYED'&&
    verified.head===sha&&
    /^[a-f0-9]{64}$/.test(verified.archive_sha256||'')&&
    verified.image_pull_allowed===false&&
    verified.image_rebuild_allowed===false&&
    verified.container_started===false&&
    verified.production_deploy_certified===false&&
    verified.signed_release_approval===false&&
    verified.time_of_use_certified===false&&
    ID.test(verified.imported_images?.backend||'')&&
    ID.test(verified.imported_images?.frontend||''),
  'prior complete OCI receiver verification required');
  const receipt=parse(readFileSync(receiptPath,'utf8'));
  check(receipt.head===sha&&
    receipt.archive?.sha256===verified.archive_sha256&&
    receipt.archive.name==='sedeagro-images-'+sha+'.tar'&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every(x=>x.config_id===verified.imported_images[x.service]),
  'current OCI receipt or Docker IDs differ from validated imported images');
  const safeEnv=envFor(sha);
  const cfg=['config','--no-env-resolution','--format','json'];
  const [baseline,candidate]=withSyntheticComposeFiles(({prod,overlay})=>[
    parse(execute(['compose','-f',prod,...cfg],safeEnv)),
    parse(execute(['compose','-f',prod,'-f',overlay,...cfg],safeEnv))
  ]);
  const ids=validateProductionOverlay(baseline,candidate,receipt,sha);
  return {
    status:'CI_OCI_PRODUCTION_TOPOLOGY_OVERLAY_VALIDATED_NOT_DEPLOYED',
    head:sha,archive_sha256:verified.archive_sha256,
    imported_images:ids,project:'sedeagro',
    base_services:['backend','db','frontend','redis'],
    build_disabled_for:['backend','frontend'],
    pull_disabled_for:['backend','frontend'],
    secrets_loaded:false,container_started:false,
    staging_certified:false,production_deploy_certified:false,
    security_owner_approved:false,time_of_use_certified:false
  };
}

async function main(){
  const argv=process.argv;
  check(argv.length===8&&argv[2]==='--sha'&&argv[4]==='--bundle'&&
    argv[6]==='--receipt',
  'expected exact SHA and TAR/receipt arguments');
  const sha=argv[3],bundlePath=resolve(argv[5]),
    receiptPath=resolve(argv[7]);
  check(process.env.CI==='true'&&
    process.env.GITHUB_ACTIONS==='true'&&
    process.env.GITHUB_EVENT_NAME==='push'&&
    process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_REPOSITORY==='FedesConsultora/SedeAgro'&&
    process.env.IMAGE_SHA===sha&&SHA40.test(sha),
  'main-only disposable GitHub CI receiver is required');
  const checkout=execFileSync('git',['rev-parse','HEAD'],{
    cwd:ROOT,encoding:'utf8',timeout:5000
  }).trim();
  const temp=resolve(process.env.RUNNER_TEMP||'/invalid','sedeagro-oci');
  check(checkout===sha&&dirname(bundlePath)===temp&&
    dirname(receiptPath)===temp&&
    basename(bundlePath)==='sedeagro-images-'+sha+'.tar'&&
    basename(receiptPath)==='sedeagro-images-'+sha+'.json',
  'checkout or private CI artifact location drift');
  const result=await inspectProductionOverlay({sha,bundlePath,receiptPath});
  console.log(JSON.stringify(result));
  console.log('NOT CERTIFIED: no Security Owner approval, container start, staging or production.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED OCI production preview: source topology, immutable image identity, or signed evidence invalid');
    process.exitCode=2;
  });
}
