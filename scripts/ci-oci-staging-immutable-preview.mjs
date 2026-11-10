// 0R.25: CI-only proof that isolated staging can use the SAME signed,
// imported OCI image config IDs with no build, pull, extra port or service.
// Never loads secrets, imports images or creates a staging container.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {inspectImmutableRuntimeCompose}
  from './ci-oci-immutable-runtime-compose.mjs';
import {validateStagingTopology}
  from './verify-staging-topology.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const STAGING=join(ROOT,'docker-compose.staging.yml');
const OVERLAY=join(ROOT,'docker-compose.staging-oci-override.yml');
const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/,ID=/^sha256:[a-f0-9]{64}$/;
const ACCEPTED='CI_OCI_IMMUTABLE_ID_PRODUCTION_COMPOSE_RESOLVED_NOT_DEPLOYED';
const SERVICES=['backend','frontend'];
const HOST='staging.ci.test';
const fakeEnvironment=(sha,ids)=>({
  COMPOSE_DISABLE_ENV_FILE:'1',COMPOSE_PROFILES:'',
  SEDEAGRO_STAGING_SHA:sha,SEDEAGRO_STAGING_HOST:HOST,
  SEDEAGRO_STAGING_OWNER_PASSWORD:'8v7XqaWn3Fpr6Kjh9MNpQ5aZ2R4uLc',
  SEDEAGRO_STAGING_APP_PASSWORD:'4sFdYqB2Cj6YtK8nQv3WX9rmS5VbTp',
  SEDEAGRO_STAGING_JWT_SECRET:'y6Qn4HprW83JaZ2Ky5QcP9VU6BNmR7dL',
  SEDEAGRO_OCI_BACKEND_IMAGE:ids.backend,
  SEDEAGRO_OCI_FRONTEND_IMAGE:ids.frontend
});
function deny(reason){throw new Error('STAGING_SIGNED_OCI_PARITY_BLOCKED: '+reason);}
function check(ok,reason){if(!ok)deny(reason);}
const docker=(args,env)=>execFileSync('docker',args,{
  encoding:'utf8',timeout:20000,maxBuffer:512*1024,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,...env},
  stdio:['ignore','pipe','pipe']
});
function readJson(raw){
  check(typeof raw==='string'&&raw.length>2&&raw.length<512*1024,
    'unbounded staging Compose preview');
  try{return JSON.parse(raw);}catch{deny('invalid staging Compose preview JSON');}
}
function withStagingFiles(callback){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-oci-staging-ci-'));
  try{
    const source=join(dir,'docker-compose.staging.yml');
    const overlay=join(dir,'docker-compose.staging-oci-override.yml');
    writeFileSync(source,readFileSync(STAGING),{mode:0o600,flag:'wx'});
    writeFileSync(overlay,readFileSync(OVERLAY),{mode:0o600,flag:'wx'});
    return callback({source,overlay});
  }finally{rmSync(dir,{recursive:true,force:true});}
}
export function validateImmutableStagingCompose(base,locked,ids,sha,
  validate=validateStagingTopology){
  check(SHA.test(sha||'')&&
    SERVICES.every(x=>ID.test(ids?.[x]||''))&&
    ids.backend!==ids.frontend,
  'two distinct signed image IDs and source commit required');
  const review=validate(base,{sha,host:HOST});
  check(review?.status==='CONFIG_REVIEW_REQUIRED'&&
    review.project==='sedeagro-staging'&&review.release_sha===sha&&
    review.runtime_certified===false,
  'original staging Compose must pass full isolated topology admission');
  const expected=structuredClone(base);
  for(const service of SERVICES){
    check(expected.services?.[service]?.build&&
      expected.services[service].image==='sedeagro-staging-'+service+':'+sha,
    'base staging image does not bind exact signed source');
    delete expected.services[service].build;
    expected.services[service].image=ids[service];
    expected.services[service].pull_policy='never';
  }
  check(isDeepStrictEqual(expected,locked),
    'signed staging Compose may only replace two builds with immutable no-pull image IDs');
  return ids;
}
export async function inspectImmutableStagingCompose({
  sha,bundlePath,receiptPath,
  review=inspectImmutableRuntimeCompose,
  execute=docker,validate=validateStagingTopology
}={}){
  check(SHA.test(sha||'')&&typeof bundlePath==='string'&&
    typeof receiptPath==='string',
  'exact source SHA and signed OCI artifacts required');
  const approved=await review({sha,bundlePath,receiptPath});
  check(approved?.status===ACCEPTED&&approved.head===sha&&
    HEX.test(approved.archive_sha256||'')&&
    approved.uses_config_ids===true&&
    approved.referenced_mutable_tags===false&&
    approved.real_production_compose_checked===true&&
    approved.containers_started===false&&
    approved.containers_created===false&&
    approved.production_go===false&&
    approved.security_owner_approved===false&&
    approved.staging_certified===false&&
    approved.time_of_use_certified===false&&
    SERVICES.every(x=>ID.test(approved.immutable_images?.[x]||'')),
  'complete immutable CI receiver proof required before staging config preview');
  let receipt;
  try{receipt=JSON.parse(readFileSync(receiptPath,'utf8'));}
  catch{deny('signed OCI receipt invalid');}
  check(receipt?.head===sha&&
    receipt.archive?.name==='sedeagro-images-'+sha+'.tar'&&
    receipt.archive.sha256===approved.archive_sha256&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((im,i)=>im.service===SERVICES[i]&&
      im.config_id===approved.immutable_images[im.service]),
  'OCI receipt and imported Docker identities differ');
  const ids=approved.immutable_images,env=fakeEnvironment(sha,ids);
  const config=['config','--no-env-resolution','--format','json'];
  const [base,locked]=withStagingFiles(({source,overlay})=>[
    readJson(execute(['compose','--env-file','/dev/null',
      '-f',source,...config],env)),
    readJson(execute(['compose','--env-file','/dev/null',
      '-f',source,'-f',overlay,...config],env))
  ]);
  const exact=validateImmutableStagingCompose(base,locked,ids,sha,validate);
  return {
    status:'CI_SIGNED_OCI_IMMUTABLE_STAGING_COMPOSE_PARITY_NOT_DEPLOYED',
    head:sha,archive_sha256:approved.archive_sha256,
    signed_image_ids:exact,project:'sedeagro-staging',
    only_backend_frontend_image_fields_changed:true,
    local_build_disabled:true,image_pull_disabled:true,
    private_network_preserved:true,db_redis_and_volume_pins_preserved:true,
    staging_loopback_port_preserved:true,
    production_env_read:false,
    containers_started:false,containers_created:false,
    staging_certified:false,production_go:false,
    security_owner_approved:false
  };
}
async function main(){
  const a=process.argv;
  check(a.length===8&&a[2]==='--sha'&&a[4]==='--bundle'&&
    a[6]==='--receipt'&&SHA.test(a[3]||''),
  'usage --sha SHA40 --bundle TAR --receipt JSON');
  const sha=a[3],bundlePath=resolve(a[5]),receiptPath=resolve(a[7]);
  check(process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'&&
    process.env.GITHUB_EVENT_NAME==='push'&&
    process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_REPOSITORY==='FedesConsultora/SedeAgro'&&
    process.env.IMAGE_SHA===sha,
  'exact disposable GitHub push-main receiver required');
  const head=execFileSync('git',['rev-parse','HEAD'],{
    cwd:ROOT,encoding:'utf8',timeout:5000
  }).trim();
  const dir=resolve(process.env.RUNNER_TEMP||'/invalid','sedeagro-oci');
  check(head===sha&&dirname(bundlePath)===dir&&
    dirname(receiptPath)===dir&&
    basename(bundlePath)==='sedeagro-images-'+sha+'.tar'&&
    basename(receiptPath)==='sedeagro-images-'+sha+'.json',
  'wrong CI artifacts or source checkout');
  const report=await inspectImmutableStagingCompose({sha,bundlePath,receiptPath});
  console.log(JSON.stringify(report));
  console.log('NOT CERTIFIED: no HTTPS staging, database connectivity or operator approval.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED staging signed OCI preview: invalid source, topology or imported identity');
    process.exitCode=2;
  });
}
