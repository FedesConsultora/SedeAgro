// 0R.16 — read-only immutable-image ID resolution of real production Compose.
// GitHub push/main receiver ONLY, after signed OCI checks and disposable import.
// Not a production deployment, authorization, Docker pull or container start.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateImportedImage } from './ci-oci-import-rehearsal.mjs';
import {
  inspectProductionOverlay, validateProductionOverlay, withSyntheticComposeFiles
} from './ci-oci-production-overlay.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA40=/^[a-f0-9]{40}$/;
const IMAGE=/^sha256:[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
const APPROVED_PREVIEW='CI_OCI_PRODUCTION_TOPOLOGY_OVERLAY_VALIDATED_NOT_DEPLOYED';
function block(message){throw new Error('IMMUTABLE_PRODUCTION_COMPOSE_BLOCKED: '+message);}
function requireSafe(condition,message){if(!condition)block(message);}
const docker=(args,env)=>execFileSync('docker',args,{
  encoding:'utf8',timeout:20000,maxBuffer:512*1024,
  env:{PATH:process.env.PATH,HOME:process.env.HOME,...env},
  stdio:['ignore','pipe','pipe']
});
function parse(value){
  requireSafe(typeof value==='string'&&value.length>2&&value.length<512*1024,
    'unbounded or empty Docker config');
  try{return JSON.parse(value);}catch{block('Docker config or image inspect was not JSON');}
}
const environment=(sha,images)=>({
  COMPOSE_DISABLE_ENV_FILE:'1',COMPOSE_PROFILES:'',
  SEDEAGRO_RELEASE_SHA:sha,
  SEDEAGRO_OCI_BACKEND_IMAGE:images.backend,
  SEDEAGRO_OCI_FRONTEND_IMAGE:images.frontend,
  POSTGRES_PASSWORD:'DISPOSABLE_COMPOSE_PREVIEW_ONLY',
  APP_DB_PASSWORD:'DISPOSABLE_COMPOSE_PREVIEW_ONLY'
});
export function validateImmutableRuntimeCompose(base,tagged,locked,receipt,sha,imported){
  requireSafe(SHA40.test(sha||'')&&receipt?.head===sha&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((im,i)=>im.service===SERVICES[i]&&
      IMAGE.test(im.config_id||'')&&
      im.tag==='sedeagro-'+im.service+'-rc:'+sha),
  'two exact signed OCI image identities required');
  // Reuse production topology proof, including DB/Redis pins, volumes,
  // private networks, no public ports and the strict no-build/no-pull diff.
  const fromTagged=validateProductionOverlay(base,tagged,receipt,sha);
  requireSafe(SERVICES.every(name=>fromTagged[name]===imported?.[name]),
    'imported Docker image identities differ from verified topology');
  const expected=structuredClone(tagged);
  for(const im of receipt.images){
    expected.services[im.service].image=im.config_id;
    requireSafe(!expected.services[im.service].build&&
      expected.services[im.service].pull_policy==='never',
    'locked service must not permit rebuild or pull');
  }
  requireSafe(isDeepStrictEqual(locked,expected),
    'immutable Compose must differ ONLY in two image values');
  return Object.fromEntries(receipt.images.map(im=>[im.service,im.config_id]));
}
export async function inspectImmutableRuntimeCompose({
  sha,bundlePath,receiptPath,
  preview=inspectProductionOverlay,execute=docker
}={}){
  requireSafe(SHA40.test(sha||'')&&
    typeof bundlePath==='string'&&typeof receiptPath==='string',
  'exact source SHA and OCI artifact paths required');
  // The previous CI steps checked the GitHub Sigstore OIDC signatures and
  // imported TAR. Recheck the full production topology on this same daemon.
  const checked=await preview({sha,bundlePath,receiptPath});
  requireSafe(checked?.status===APPROVED_PREVIEW&&checked.head===sha&&
    /^[a-f0-9]{64}$/.test(checked.archive_sha256||'')&&
    checked.container_started===false&&
    checked.secrets_loaded===false&&
    checked.production_deploy_certified===false&&
    checked.time_of_use_certified===false&&
    checked.security_owner_approved===false&&
    SERVICES.every(service=>IMAGE.test(checked.imported_images?.[service]||'')),
  'full OCI import and production topology review required first');
  const receipt=parse(readFileSync(receiptPath,'utf8'));
  requireSafe(receipt.head===sha&&
    receipt.archive?.name==='sedeagro-images-'+sha+'.tar'&&
    receipt.archive.sha256===checked.archive_sha256&&
    Array.isArray(receipt.images)&&receipt.images.length===2&&
    receipt.images.every((im,i)=>im.service===SERVICES[i]&&
      im.config_id===checked.imported_images[im.service]),
  'receipt does not bind the reviewed immutable images');
  const tags=Object.fromEntries(receipt.images.map(im=>[im.service,im.tag]));
  const ids=Object.fromEntries(receipt.images.map(im=>[im.service,im.config_id]));
  const flags=['config','--no-env-resolution','--format','json'];
  const [base,tagged,locked]=withSyntheticComposeFiles(({prod,overlay})=>[
    parse(execute(['compose','-f',prod,...flags],environment(sha,tags))),
    parse(execute(['compose','-f',prod,'-f',overlay,...flags],environment(sha,tags))),
    parse(execute(['compose','-f',prod,'-f',overlay,...flags],environment(sha,ids)))
  ]);
  const exact=validateImmutableRuntimeCompose(
    base,tagged,locked,receipt,sha,checked.imported_images);
  // Inspect by IMMUTABLE config ID, not a tag which may have been moved.
  // Require all signed layers, revision labels, OS/arch and backend build SHA.
  // Repeat after resolving Compose, to detect in-process registry mutation.
  for(let repetition=0;repetition<2;repetition++){
    for(const im of receipt.images){
      const image=parse(execute(['image','inspect','--format','{{json .}}',
        im.config_id],{}));
      validateImportedImage(image,im,sha);
    }
  }
  return {
    status:'CI_OCI_IMMUTABLE_ID_PRODUCTION_COMPOSE_RESOLVED_NOT_DEPLOYED',
    head:sha,archive_sha256:checked.archive_sha256,
    immutable_images:exact,
    project:'sedeagro',build_disabled_for:SERVICES,
    pull_disabled_for:SERVICES,uses_config_ids:true,
    referenced_mutable_tags:false,
    real_production_compose_checked:true,
    live_secrets_loaded:false,network_created:false,
    containers_created:false,containers_started:false,
    production_go:false,staging_certified:false,
    security_owner_approved:false,time_of_use_certified:false
  };
}
async function main(){
  const a=process.argv;
  requireSafe(a.length===8&&a[2]==='--sha'&&a[4]==='--bundle'&&
    a[6]==='--receipt'&&SHA40.test(a[3]||''),
  'usage --sha SHA40 --bundle TAR --receipt JSON');
  const sha=a[3],bundlePath=resolve(a[5]),receiptPath=resolve(a[7]);
  requireSafe(process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'&&
    process.env.GITHUB_EVENT_NAME==='push'&&
    process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_REPOSITORY==='FedesConsultora/SedeAgro'&&
    process.env.IMAGE_SHA===sha,
  'exact main-only disposable GitHub CI receiver required');
  const checkout=execFileSync('git',['rev-parse','HEAD'],{
    cwd:ROOT,encoding:'utf8',timeout:5000
  }).trim();
  const folder=resolve(process.env.RUNNER_TEMP||'/invalid','sedeagro-oci');
  requireSafe(checkout===sha&&dirname(bundlePath)===folder&&
    dirname(receiptPath)===folder&&
    basename(bundlePath)==='sedeagro-images-'+sha+'.tar'&&
    basename(receiptPath)==='sedeagro-images-'+sha+'.json',
  'wrong checkout SHA or untrusted artifact location');
  const proof=await inspectImmutableRuntimeCompose({sha,bundlePath,receiptPath});
  console.log(JSON.stringify(proof));
  console.log('NOT CERTIFIED: no Security Owner, deploy approval, staging or runtime cutover.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED immutable OCI Compose: exact signed image ID or topology proof missing');
    process.exitCode=2;
  });
}