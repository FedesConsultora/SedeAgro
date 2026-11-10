// 0R.21: execute BOTH imported, signed production image processes by immutable
// sha256 config ID on an isolated GitHub runner. Not an actual deployment.
// The upstream OCI Sigstore security checks are mandatory earlier CI steps.
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectImmutableRuntimeCompose} from './ci-oci-immutable-runtime-compose.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{40}$/,ID=/^sha256:[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
const READY='CI_OCI_IMMUTABLE_ID_PRODUCTION_COMPOSE_RESOLVED_NOT_DEPLOYED';
const OK_BACKEND='CI_OCI_BACKEND_HEALTH_OK:';
const OK_FRONTEND='CI_OCI_FRONTEND_NGINX_CONFIG_OK';
function deny(reason){throw new Error('OCI_NETWORKLESS_PROCESS_BLOCKED: '+reason);}
function check(ok,reason){if(!ok)deny(reason);}

const docker=args=>execFileSync('docker',args,{
  encoding:'utf8',timeout:30000,maxBuffer:64*1024,
  // Do not inherit Docker endpoint or Compose/registry overrides from CI.
  env:{PATH:process.env.PATH,HOME:process.env.HOME},
  stdio:['ignore','pipe','pipe']
});

function receiptOf(path,sha){
  const raw=readFileSync(path,'utf8');
  check(raw.length>20&&raw.length<64*1024,'unbounded receipt');
  let data;
  try{data=JSON.parse(raw);}catch{deny('invalid OCI receipt');}
  check(data?.head===sha&&Array.isArray(data.images)&&
    data.images.length===2&&data.images.every((im,i)=>
      im.service===SERVICES[i]&&ID.test(im.config_id||'')&&
      im.tag==='sedeagro-'+im.service+'-rc:'+sha),
  'receipt must identify the exact signed backend/frontend config IDs');
  return data;
}

// A deliberately unreachable DB makes real Express /health/ready return 503.
// This verifies fail-closed readiness without any database or network access.
export const backendProbe=String.raw`import {createApp} from './src/app.js';
const app=createApp();
const server=app.listen(0,'127.0.0.1',async()=>{
  let stage='liveness';
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const live=await fetch(base+'/health');
    const liveBody=await live.json();
    if(live.status!==200||liveBody.ok!==true||
       liveBody.service!=='sedeagro-backend')throw new Error('unhealthy');
    stage='revision';
    const rev=await fetch(base+'/health/revision');
    const revBody=await rev.json();
    if(rev.status!==200||revBody.revision!==process.env.SEDEAGRO_BUILD_SHA)
      throw new Error('revision invalid');
    stage='readiness';
    const ready=await fetch(base+'/health/ready',{
      signal:AbortSignal.timeout(10000)});
    const readyBody=await ready.json();
    if(ready.status!==503||readyBody.ready!==false)
      throw new Error('readiness failed open');
    console.log('CI_OCI_BACKEND_HEALTH_OK:'+revBody.revision);
  }catch{
    console.error('CI_OCI_BACKEND_PROBE_STAGE:'+stage);
    process.exitCode=1;
  }finally {server.close(()=>process.exit(process.exitCode||0));}
});
setTimeout(()=>process.exit(3),16000).unref();`;

export const frontendProbe=String.raw`set -eu
test -s /usr/share/nginx/html/index.html
test -s /usr/share/nginx/html/sw.js
test ! -e /usr/share/nginx/html/.env
test ! -e /usr/share/nginx/html/node_modules
if ! nginx -t >/dev/null 2>/tmp/sedeagro-nginx-syntax.err; then
  # Do not print raw Nginx paths, parsed config or arbitrary error text.
  # Only a small authored category is safe in CI logs.
  stage=syntax
  if grep -qiE 'host not found in upstream|could not be resolved|no resolver defined' /tmp/sedeagro-nginx-syntax.err; then
    stage=upstream
  elif grep -qiE 'read-only file system|permission denied|mkdir\(\)|open\(\).*failed' /tmp/sedeagro-nginx-syntax.err; then
    stage=filesystem
  elif grep -qiE 'unknown directive|invalid number|unexpected|duplicate' /tmp/sedeagro-nginx-syntax.err; then
    stage=config
  fi
  printf 'CI_OCI_FRONTEND_NGINX_CONFIG_STAGE:%s\n' "$stage" >&2
  exit 12
fi
printf 'CI_OCI_FRONTEND_NGINX_CONFIG_OK\n'`;

function runtimeArgs(service,imageId,name){
  check(SERVICES.includes(service)&&ID.test(imageId)&&
    /^sedeagro-ci-oci-[a-z]+-[a-f0-9]{12}$/.test(name),
  'unreviewed process or temporary container identity');
  const common=[
    'container','run','--rm','--pull=never','--name',name,
    '--network=none','--read-only',
    '--cap-drop=ALL','--security-opt=no-new-privileges',
    '--pids-limit=64','--memory=256m','--cpus=1',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=16m'
  ];
  if(service==='backend')return [...common,
    '--env','NODE_ENV=production','--env','PORT=3001',
    '--env','DATABASE_URL=postgres://isolated:ci@127.0.0.1:5432/absent',
    '--env','JWT_SECRET=CIOnlyIsolatedRuntimeKey1234567890abcdef',
    '--env','SEED_MODE=prod','--env','LOG_SQL=0',
    '--env','LOG_STACK=0','--workdir','/app',
    '--entrypoint','node',imageId,'--input-type=module','-e',backendProbe];
  return [...common,
    '--tmpfs','/var/cache/nginx:rw,nosuid,nodev,mode=1777,size=16m',
    '--tmpfs','/run:rw,nosuid,nodev,mode=1777,size=4m',
    '--tmpfs','/var/log/nginx:rw,nosuid,nodev,mode=1777,size=8m',
    '--add-host','sedeagro_backend:127.0.0.1',
    '--entrypoint','sh',imageId,'-ec',frontendProbe];
}

export async function rehearseRunningImageProcesses({
  sha,bundlePath,receiptPath,review=inspectImmutableRuntimeCompose,
  execute=docker,suffix=()=>randomBytes(6).toString('hex')
}={}){
  check(SHA.test(sha||'')&&typeof bundlePath==='string'&&
    typeof receiptPath==='string',
  'exact source SHA and verified TAR/receipt required');
  const proof=await review({sha,bundlePath,receiptPath});
  check(proof?.status===READY&&proof.head===sha&&
    /^[a-f0-9]{64}$/.test(proof.archive_sha256||'')&&
    proof.uses_config_ids===true&&
    proof.referenced_mutable_tags===false&&
    proof.real_production_compose_checked===true&&
    proof.containers_created===false&&
    proof.containers_started===false&&
    proof.production_go===false&&
    proof.security_owner_approved===false&&
    proof.staging_certified===false&&
    proof.time_of_use_certified===false&&
    SERVICES.every(x=>ID.test(proof.immutable_images?.[x]||''))&&
    proof.immutable_images.backend!==proof.immutable_images.frontend,
  'signed archive and immutable no-build/no-pull Compose review required before running');
  const receipt=receiptOf(receiptPath,sha);
  check(receipt.archive?.sha256===proof.archive_sha256&&
    receipt.archive.name==='sedeagro-images-'+sha+'.tar'&&
    receipt.images.every(im=>im.config_id===proof.immutable_images[im.service]),
  'reviewed Docker config IDs differ from signed OCI receipt');
  const successes={};
  for(const im of receipt.images){
    const random=suffix();
    check(typeof random==='string'&&/^[a-f0-9]{12}$/.test(random),
      'only unpredictable short private CI container suffixes accepted');
    const name='sedeagro-ci-oci-'+im.service+'-'+random;
    let failure=null,output='',dirty=false;
    try{
      // imageId is the signed Docker config ID, NOT a tag. Neither script
      // exposes host ports, volumes, credentials or live network access.
      output=execute(runtimeArgs(im.service,im.config_id,name));
    }catch(error){
      const stderr=typeof error?.stderr==='string'?error.stderr:'';
      const stage=im.service==='backend'
        ? /CI_OCI_BACKEND_PROBE_STAGE:(liveness|revision|readiness)/.exec(stderr)?.[1]
        : /CI_OCI_FRONTEND_NGINX_CONFIG_STAGE:(syntax|upstream|filesystem|config)/.exec(stderr)?.[1];
      const code=Number.isInteger(error?.status)&&error.status>=0&&
        error.status<=255?error.status:'unknown';
      // Only include authored, enumerable stage + exit code. Never reveal
      // raw Docker stderr, image contents, paths or environment variables.
      failure=im.service+' process exit='+code+' stage='+(stage||'startup');
    }
    finally{
      try{
        const inspect=()=>execute(['container','ls','--all','--quiet',
          '--no-trunc','--filter','name=^/'+name+'$']);
        const existing=inspect();
        check(typeof existing==='string'&&existing.length<512,
          'unbounded disposable container listing');
        if(existing.trim()!==''){
          dirty=true;
          execute(['container','rm','--force','--volumes',name]);
          check(inspect().trim()==='','CI container cleanup incomplete');
        }
      }catch{dirty=true;}
    }
    if(dirty)deny('disposable image process container was not removed cleanly');
    if(failure)deny(failure);
    check(typeof output==='string'&&output.length<32*1024&&
      output.includes(im.service==='backend'?OK_BACKEND+sha:OK_FRONTEND),
    'runtime process did not confirm expected backend health or frontend Nginx');
    successes[im.service]=im.config_id;
  }
  return {
    status:'CI_OCI_NETWORKLESS_RUNTIME_SMOKE_SUCCESS_NOT_DEPLOYED',
    head:sha,archive_sha256:proof.archive_sha256,
    executed_image_ids:successes,
    real_express_liveness:true,real_revision_matches_signed_image:true,
    readiness_without_database_is_unavailable:true,
    frontend_static_assets_present:true,real_nginx_config_valid:true,
    image_pull_allowed:false,image_build_allowed:false,
    network_created:false,ports_exposed:false,host_data_mounted:false,
    all_disposable_containers_removed:true,production_go:false,
    staging_certified:false,security_owner_approved:false,
    production_cutover_tested:false
  };
}
async function main(){
  const a=process.argv;
  check(a.length===8&&a[2]==='--sha'&&a[4]==='--bundle'&&
    a[6]==='--receipt'&&SHA.test(a[3]||''),
  'only --sha SHA40 --bundle TAR --receipt JSON');
  const sha=a[3],bundlePath=resolve(a[5]),receiptPath=resolve(a[7]);
  check(process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'&&
    process.env.GITHUB_EVENT_NAME==='push'&&
    process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_REPOSITORY==='FedesConsultora/SedeAgro'&&
    process.env.IMAGE_SHA===sha&&
    !['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH',
      'COMPOSE_FILE','COMPOSE_ENV_FILES'].some(k=>process.env[k]),
  'exact isolated push-main CI runner and local Docker required');
  const head=execFileSync('git',['rev-parse','HEAD'],{
    cwd:ROOT,encoding:'utf8',timeout:5000
  }).trim();
  const dir=resolve(process.env.RUNNER_TEMP||'/invalid','sedeagro-oci');
  check(head===sha&&dirname(bundlePath)===dir&&dirname(receiptPath)===dir&&
    basename(bundlePath)==='sedeagro-images-'+sha+'.tar'&&
    basename(receiptPath)==='sedeagro-images-'+sha+'.json',
  'wrong source checkout or OCI artifact location');
  const result=await rehearseRunningImageProcesses({sha,bundlePath,receiptPath});
  console.log(JSON.stringify(result));
  console.log('NOT CERTIFIED: no database, staging, Security Owner or production cutover.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(error=>{
    const message=String(error?.message||'');
    const authored=/^OCI_NETWORKLESS_PROCESS_BLOCKED: (?:backend|frontend) process exit=(?:[0-9]{1,3}|unknown) stage=(?:liveness|revision|readiness|syntax|upstream|filesystem|config|startup)$/.exec(message);
    console.error('BLOCKED OCI runtime smoke: '+(authored?
      authored[0].replace('OCI_NETWORKLESS_PROCESS_BLOCKED: ',''):
      'signed image, isolated process or cleanup did not pass'));
    process.exitCode=2;
  });
}
