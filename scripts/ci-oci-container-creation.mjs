// 0P.37 — immutable OCI point-of-container-creation proof on a disposable
// GitHub CI Docker daemon. NEVER start containers or deploy to staging/prod.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProductionOverlay } from './ci-oci-production-overlay.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA40=/^[a-f0-9]{40}$/;
const ID=/^sha256:[a-f0-9]{64}$/;
const CID=/^[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
const VERIFIED='CI_OCI_PRODUCTION_TOPOLOGY_OVERLAY_VALIDATED_NOT_DEPLOYED';
function block(s){throw new Error('IMMUTABLE_CONTAINER_CREATE_BLOCKED: '+s);}
function check(v,s){if(!v)block(s);}
const docker=(args)=>execFileSync('docker',args,{
  encoding:'utf8',timeout:15000,maxBuffer:512*1024,
  env:{PATH:process.env.PATH,HOME:process.env.HOME},
  stdio:['ignore','pipe','pipe']
});
function asJson(raw){
  check(typeof raw==='string'&&raw.length>2&&raw.length<512*1024,
    'missing or unbounded docker inspect response');
  try{return JSON.parse(raw);}catch{block('invalid Docker inspection');}
}
function readReceipt(file){
  check(typeof file==='string'&&file.length>0,'receipt path required');
  return asJson(readFileSync(file,'utf8'));
}

export function validateCreatedContainer(container,expected,sha,name,containerId){
  check(SHA40.test(sha||'')&&ID.test(expected?.config_id||'')&&
    SERVICES.includes(expected?.service)&&
    expected.tag==='sedeagro-'+expected.service+'-rc:'+sha&&
    CID.test(containerId||'')&&typeof name==='string'&&
    /^[a-z0-9][a-z0-9-]{8,100}$/.test(name),
  'receipt, SHA, container ID or reserved name invalid');
  check(container&&container.Id===containerId&&
    container.Name==='/'+name&&
    container.Image===expected.config_id&&
    container.Config?.Image===expected.config_id&&
    container.State?.Status==='created'&&
    container.State?.Running===false&&
    container.State?.StartedAt==='0001-01-01T00:00:00Z'&&
    container.HostConfig?.NetworkMode==='none'&&
    container.HostConfig?.ReadonlyRootfs===true&&
    container.HostConfig?.Privileged===false&&
    (container.HostConfig?.AutoRemove===false||
      container.HostConfig?.AutoRemove===undefined)&&
    (!container.HostConfig?.PortBindings||
      Object.keys(container.HostConfig.PortBindings).length===0)&&
    Array.isArray(container.Mounts)&&container.Mounts.length===0&&
    Array.isArray(container.Config.Entrypoint)&&
    container.Config.Entrypoint.length===1&&
    container.Config.Entrypoint[0]===(expected.service==='backend'?'node':'nginx')&&
    JSON.stringify(container.Config.Cmd)===
      JSON.stringify(expected.service==='backend'?['--version']:['-v']),
  'created container must bind exact OCI image, remain stopped and isolated');
  return expected.config_id;
}

export async function rehearseImmutableContainerCreate({
  sha,bundlePath,receiptPath,
  preview=inspectProductionOverlay,execute=docker,
  nameSuffix=()=>randomBytes(6).toString('hex')
}={}){
  check(SHA40.test(sha||'')&&typeof bundlePath==='string'&&
    typeof receiptPath==='string',
  'immutable SHA and signed artifact paths required');
  // The signed GH OIDC/Sigstore verification is a separate preceding CI step.
  // This re-checks archive/rootfs/config and real production Compose preview.
  const accepted=await preview({sha,bundlePath,receiptPath});
  check(accepted?.status===VERIFIED&&accepted.head===sha&&
    /^[a-f0-9]{64}$/.test(accepted.archive_sha256||'')&&
    accepted.container_started===false&&
    accepted.production_deploy_certified===false&&
    accepted.time_of_use_certified===false&&
    accepted.security_owner_approved===false&&
    accepted.secrets_loaded===false,
  'complete signed OCI import+Compose preview required before container creation');
  const receipt=readReceipt(receiptPath);
  check(receipt.head===sha&&
    receipt.archive?.sha256===accepted.archive_sha256&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((im,i)=>im?.service===SERVICES[i]&&
      im.tag==='sedeagro-'+im.service+'-rc:'+sha&&
      ID.test(im.config_id||'')&&
      im.config_id===accepted.imported_images?.[im.service]),
  'receipt or immutable image IDs do not match checked OCI TAR');
  const ids={};
  for(const im of receipt.images){
    const suffix=nameSuffix();
    check(typeof suffix==='string'&&/^[a-f0-9]{12}$/.test(suffix),
      'only random bounded disposable CI container names permitted');
    const name='sedeagro-oci-'+im.service+'-'+sha.slice(0,12)+'-'+suffix;
    const command=im.service==='backend'?'node':'nginx';
    let attempted=false,proofError;
    try{
      // Choose an IMMUTABLE config ID, not a mutable tag. Even if another
      // process retags after validation, Docker binds this exact image ID.
      const create=[
        'container','create','--pull=never','--network=none','--read-only',
        '--name',name,'--entrypoint',command,im.config_id,
        im.service==='backend'?'--version':'-v'
      ];
      attempted=true;
      const containerId=execute(create)?.trim();
      check(CID.test(containerId||''),'Docker did not return a valid immutable container ID');
      const output=execute(['container','inspect','--format','{{json .}}',containerId]);
      const container=asJson(output);
      ids[im.service]=validateCreatedContainer(container,im,sha,name,containerId);
    }catch(e){
      proofError=e;
    }finally{
      if(attempted){
        // Always delete stopped containers AND anonymous volumes, including
        // failed/partially-created ones. Any cleanup failure is a CI failure.
        try{
          execute(['container','rm','--force','--volumes',name]);
          const remaining=execute([
            'container','ls','--all','--quiet','--no-trunc',
            '--filter','name=^/'+name+'$'
          ]);
          check(typeof remaining==='string'&&remaining.trim()==='',
            'CI container cleanup incomplete');
        }catch{
          block('disposable container cleanup failed');
        }
      }
    }
    if(proofError)throw proofError;
  }
  return {
    status:'CI_OCI_STOPPED_CONTAINER_CREATION_IMAGE_IDS_VERIFIED_NOT_DEPLOYED',
    head:sha,archive_sha256:accepted.archive_sha256,
    created_image_ids:ids,verified_by_immutable_id:true,
    used_image_tags_for_creation:false,image_pull_allowed:false,
    container_started:false,network_created:false,
    all_disposable_containers_removed:true,
    security_owner_approved:false,production_deploy_certified:false,
    runtime_compose_certified:false,production_race_lock_certified:false
  };
}
async function main(){
  const a=process.argv;
  check(a.length===8&&a[2]==='--sha'&&a[4]==='--bundle'&&
    a[6]==='--receipt','expected --sha SHA40 --bundle TAR --receipt JSON');
  const sha=a[3],bundlePath=resolve(a[5]),receiptPath=resolve(a[7]);
  check(SHA40.test(sha||'')&&process.env.CI==='true'&&
    process.env.GITHUB_ACTIONS==='true'&&
    process.env.GITHUB_EVENT_NAME==='push'&&
    process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_REPOSITORY==='FedesConsultora/SedeAgro'&&
    process.env.IMAGE_SHA===sha,
  'GitHub disposable push/main exact SHA only');
  const head=execFileSync('git',['rev-parse','HEAD'],{
    cwd:ROOT,encoding:'utf8',timeout:5000
  }).trim();
  const temp=resolve(process.env.RUNNER_TEMP||'/invalid','sedeagro-oci');
  check(head===sha&&dirname(bundlePath)===temp&&dirname(receiptPath)===temp&&
    basename(bundlePath)==='sedeagro-images-'+sha+'.tar'&&
    basename(receiptPath)==='sedeagro-images-'+sha+'.json',
  'checkout and private signed artifacts must be exact SHA');
  const proof=await rehearseImmutableContainerCreate({sha,bundlePath,receiptPath});
  console.log(JSON.stringify(proof));
  console.log('NOT CERTIFIED: Security Owner, production Compose up, lock and staging.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED OCI container creation: immutable image identity or secure disposable cleanup failed');
    process.exitCode=2;
  });
}
