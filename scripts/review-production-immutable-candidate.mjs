// 0R.19 — operator read-only join of independent human risk acceptance and
// exact on-host Docker image/Compose identity. NEVER performs deployment.
// Security Owner risk acceptance is NOT deploy, staging, Ops or Product GO.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSignedImageCandidate } from './verify-production-image-admission.mjs';
import { previewSignedHostCompose } from './inspect-host-oci-compose.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/,ID=/^sha256:[a-f0-9]{64}$/;
const HUMAN='HUMAN_SIGNED_OCI_IMAGE_RISK_REVIEW_NOT_DEPLOYED';
const HOST='HOST_SIGNED_OCI_COMPOSE_PARITY_READONLY_NOT_DEPLOYED';
function fail(reason){throw new Error('IMMUTABLE_RELEASE_CANDIDATE_BLOCKED: '+reason);}
function check(ok,why){if(!ok)fail(why);}
const required=['backend','frontend'];

export async function reviewImmutableReleaseCandidate({
  sha,evidenceDir,
  checkHuman=inspectSignedImageCandidate,
  checkHost=previewSignedHostCompose
}={}){
  check(SHA.test(sha||'')&&typeof evidenceDir==='string'&&
    evidenceDir.length>0&&evidenceDir.length<4096,
  'exact SHA and dedicated evidence directory required');
  // Trust verification MUST precede even read-only host Docker inspection.
  // The sole real trust root is scripts/security-owner-trust.json (EMPTY
  // until a reviewed, independent human key enrollment).
  const human=await checkHuman({sha,evidenceDir});
  check(human?.status===HUMAN&&human.head===sha&&
    HEX.test(human.oci_archive_sha256||'')&&
    HEX.test(human.oci_receipt_sha256||'')&&
    HEX.test(human.security_receipt_sha256||'')&&
    HEX.test(human.signer_key_id||'')&&
    human.security_owner_risk_accepted===true&&
    human.staging_certified===false&&
    human.other_owners_approved===false&&
    human.production_go===false&&
    human.time_of_use_certified===false&&
    human.images_loaded===false&&
    human.containers_created===false,
  'cryptographically signed human image-risk review required');
  const host=await checkHost({sha,evidenceDir});
  check(host?.status===HOST&&host.head===sha&&
    host.oci_archive_sha256===human.oci_archive_sha256&&
    host.oci_receipt_sha256===human.oci_receipt_sha256&&
    host.security_receipt_sha256===human.security_receipt_sha256&&
    host.immutable_config_ids_bound===true&&
    host.mutable_tag_reference_in_final_plan===false&&
    host.docker_identity_rechecked_after_compose===true&&
    host.preview_uses_synthetic_files===true&&
    host.production_env_read===false&&
    host.live_compose_config_used===false&&
    host.image_pull_allowed===false&&
    host.build_allowed===false&&
    host.containers_created===false&&
    host.containers_started===false&&
    host.release_go===false&&
    host.security_owner_approved===false&&
    host.time_of_container_create_certified===false&&
    host.staging_deploy_certified===false&&
    host.production_deploy_certified===false&&
    host.compose_project==='sedeagro'&&
    required.every(name=>ID.test(host.inspected_image_ids?.[name]||''))&&
    host.inspected_image_ids.backend!==host.inspected_image_ids.frontend,
  'host immutable Docker image IDs or signature inventory differ from signed human risk');
  return {
    status:'IMMUTABLE_RELEASE_CANDIDATE_REVIEWED_NOT_DEPLOYED',
    head:sha,archive_sha256:human.oci_archive_sha256,
    receipt_sha256:human.oci_receipt_sha256,
    security_receipt_sha256:human.security_receipt_sha256,
    signed_image_ids:host.inspected_image_ids,
    compose_image_ref_kind:'sha256-config-id',
    security_owner_risk_accepted:true,
    security_owner_deploy_approved:false,
    other_owners_evaluated:false,
    staging_certified:false,
    production_go:false,rollback_certified:false,
    production_env_read:false,
    image_loaded_by_review:false,containers_created:false,
    containers_started:false,time_of_container_create_certified:false
  };
}

async function main(){
  const a=process.argv;
  check(a.length===6&&a[2]==='--sha'&&a[4]==='--evidence-dir'&&
    SHA.test(a[3]||'')&&process.platform==='linux',
  'Linux review requires --sha SHA40 --evidence-dir PRIVATE_DIR');
  const sha=a[3];
  check(process.env.SEDEAGRO_IMMUTABLE_RELEASE_REVIEW==='REVIEW:'+sha,
    'explicit read-only operator REVIEW:<SHA> required (not DEPLOY)');
  check(!['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH','COMPOSE_FILE','COMPOSE_ENV_FILES']
    .some(key=>process.env[key]),
  'remote Docker endpoints and Compose overrides denied');
  const git=(args)=>execFileSync('git',['-C',ROOT,...args],{
    encoding:'utf8',timeout:5000,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe']
  }).trim();
  check(git(['symbolic-ref','--short','HEAD'])==='main'&&
    git(['rev-parse','HEAD'])===sha&&
    git(['rev-parse','refs/remotes/origin/main'])===sha&&
    git(['status','--porcelain','--untracked-files=no'])==='',
  'clean exact SHA main checkout required');
  const result=await reviewImmutableReleaseCandidate({
    sha,evidenceDir:a[5]
  });
  console.log(JSON.stringify(result));
  console.log('NOT AUTHORIZED: no production deploy, rollback, staging or other-owner GO.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    // Never emit Docker errors, paths, signing data, secrets or private risk text.
    console.error('BLOCKED immutable release candidate: signed human risk, exact host OCI image IDs or approvals incomplete');
    process.exitCode=2;
  });
}
