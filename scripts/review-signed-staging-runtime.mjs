// 0R.27 — read-only post-start staging inspection bound to a real human
// Ed25519 risk acceptance and exact signed OCI Docker config IDs.
// Neither risk acceptance nor a healthy staging container is deployment GO.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSignedImageCandidate } from './verify-production-image-admission.mjs';
import { inspectHostSignedImages } from './inspect-host-oci-images.mjs';
import { inspectStagingRuntime } from './verify-staging-runtime.mjs';
import { validateStagingHost } from './verify-staging-topology.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{40}$/;
const HEX=/^[a-f0-9]{64}$/;
const ID=/^sha256:[a-f0-9]{64}$/;
const HUMAN='HUMAN_SIGNED_OCI_IMAGE_RISK_REVIEW_NOT_DEPLOYED';
const HOST='HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED';
function block(message) { throw new Error('SIGNED_STAGING_RUNTIME_BLOCKED: '+message); }
function check(ok,message) { if(!ok)block(message); }

function validateRisk(risk,sha) {
  check(risk?.status===HUMAN&&risk.head===sha&&
    HEX.test(risk.signer_key_id||'')&&
    HEX.test(risk.oci_archive_sha256||'')&&
    HEX.test(risk.oci_receipt_sha256||'')&&
    HEX.test(risk.security_receipt_sha256||'')&&
    risk.security_owner_risk_accepted===true&&
    risk.production_go===false&&
    risk.staging_certified===false&&
    risk.other_owners_approved===false&&
    risk.time_of_use_certified===false&&
    risk.images_loaded===false&&risk.containers_created===false,
  'independent signed human image-risk review is required first');
}
function validateHost(host,sha,risk) {
  check(host?.status===HOST&&host.head===sha&&
    host.oci_archive_sha256===risk.oci_archive_sha256&&
    host.oci_receipt_sha256===risk.oci_receipt_sha256&&
    host.security_receipt_sha256===risk.security_receipt_sha256&&
    host.local_docker_context==='default'&&
    host.signed_security_inventory_verified===true&&
    host.images_loaded_during_check===false&&
    host.containers_created===false&&
    host.image_pull_allowed===false&&host.build_allowed===false&&
    host.security_owner_approved===false&&host.release_go===false&&
    host.staging_deploy_certified===false&&
    host.production_deploy_certified===false&&
    host.time_of_container_create_certified===false&&
    host.inspected_image_ids&&
    Object.keys(host.inspected_image_ids).sort().join(',')==='backend,frontend'&&
    ID.test(host.inspected_image_ids.backend)&&
    ID.test(host.inspected_image_ids.frontend)&&
    host.inspected_image_ids.backend!==host.inspected_image_ids.frontend,
  'signed seven-subject OCI host identity or risk receipt changed');
}
function validateLive(live,sha,host,ids) {
  check(live?.status==='RUNTIME_REVIEW_REQUIRED'&&
    live.project==='sedeagro-staging'&&live.release_sha===sha&&
    live.host===host&&live.services===4&&
    live.network==='sedeagro-staging_staging_internal'&&
    live.image_reference_kind==='immutable-config-id'&&
    live.image_ids?.backend===ids.backend&&
    live.image_ids?.frontend===ids.frontend&&
    live.signed_provenance_certified===false&&
    live.registry_digest_certified===false&&
    live.tls_certified===false&&
    live.database_isolation_certified===false&&
    live.container_ids&&Object.keys(live.container_ids).sort().join(',')===
      'backend,db,frontend,redis'&&
    Object.values(live.container_ids).every(x=>HEX.test(x))&&
    new Set(Object.values(live.container_ids)).size===4,
  'staging containers, runtime health, private topology or signed image IDs differ');
}

/**
 * The real human signer has to be enrolled in the pinned trust roster first.
 * Injection points exist only for adversarial unit tests; the CLI has none.
 * Nothing here imports OCI, creates containers, execs into a DB or reads
 * environment values in a user-visible result.
 */
export async function reviewSignedStagingRuntime({
  sha,host,evidenceDir,
  verifyRisk=inspectSignedImageCandidate,
  inspectImages=inspectHostSignedImages,
  inspectRuntime=inspectStagingRuntime
}={}) {
  check(SHA.test(sha||'')&&typeof evidenceDir==='string'&&
    evidenceDir.length>0&&evidenceDir.length<4096,
  'exact main release and signed evidence directory required');
  validateStagingHost(host);
  // A risk-only Ed25519 attestation MUST pass before querying even read-only
  // host Docker. This does not grant an operations or production approval.
  const risk=await verifyRisk({sha,evidenceDir});
  validateRisk(risk,sha);
  const first=await inspectImages({sha,evidenceDir});
  validateHost(first,sha,risk);
  const ids=first.inspected_image_ids;
  const running=await inspectRuntime({sha,host,signedImageIds:ids});
  validateLive(running,sha,host,ids);
  // The image tags and project containers can change independently.
  // Recheck both; compare the same FOUR container identities and image IDs.
  const last=await inspectImages({sha,evidenceDir});
  validateHost(last,sha,risk);
  check(last.inspected_image_ids.backend===ids.backend&&
    last.inspected_image_ids.frontend===ids.frontend,
  'signed Docker image IDs drifted while staging containers were checked');
  const again=await inspectRuntime({sha,host,signedImageIds:ids});
  validateLive(again,sha,host,ids);
  check(['db','redis','backend','frontend'].every(name=>
    running.container_ids[name]===again.container_ids[name]),
  'staging Compose containers were replaced during read-only identity review');
  return {
    status:'SIGNED_OCI_STAGING_RUNTIME_IDENTITIES_REVIEWED_NOT_CERTIFIED',
    head:sha,host,project:'sedeagro-staging',
    image_ids:{backend:ids.backend,frontend:ids.frontend},
    archive_sha256:risk.oci_archive_sha256,
    receipt_sha256:risk.oci_receipt_sha256,
    security_receipt_sha256:risk.security_receipt_sha256,
    signed_risk_accepted:true,
    checked_running_container_ids:true,
    checked_immutable_image_ids:true,
    verified_same_four_containers_twice:true,
    read_only:true,containers_created:false,
    containers_started_by_review:false,production_env_read:false,
    staging_tls_certified:false,staging_db_restore_certified:false,
    staging_role_acceptance_certified:false,staging_certified:false,
    security_owner_deploy_approved:false,production_go:false,
    time_of_future_container_creation_certified:false
  };
}
async function main(){
  const a=process.argv;
  check(a.length===8&&a[2]==='--sha'&&a[4]==='--host'&&
    a[6]==='--evidence-dir'&&SHA.test(a[3]||'')&&
    process.platform==='linux',
  'usage --sha SHA40 --host staging.hostname --evidence-dir PRIVATE_DIR');
  const sha=a[3],host=a[5];
  validateStagingHost(host);
  check(process.env.SEDEAGRO_SIGNED_STAGING_REVIEW==='REVIEW:'+sha,
    'only an explicit read-only REVIEW:<SHA> is permitted');
  check(![
    'DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH',
    'DOCKER_CONFIG','DOCKER_DEFAULT_PLATFORM','BUILDX_BUILDER',
    'COMPOSE_FILE','COMPOSE_PROJECT_NAME','COMPOSE_ENV_FILES',
    'COMPOSE_PROFILES','COMPOSE_DISABLE_ENV_FILE','COMPOSE_PATH_SEPARATOR',
    'SEDEAGRO_OCI_BACKEND_IMAGE','SEDEAGRO_OCI_FRONTEND_IMAGE'
  ].some(key=>process.env[key]),
  'Docker or Compose inherited override is forbidden');
  const git=args=>execFileSync('git',['-C',ROOT,...args],{
    encoding:'utf8',timeout:5000,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe']
  }).trim();
  check(git(['symbolic-ref','--short','HEAD'])==='main'&&
    git(['rev-parse','HEAD'])===sha&&
    git(['rev-parse','refs/remotes/origin/main'])===sha&&
    git(['status','--porcelain','--untracked-files=no'])==='',
  'clean exact main and origin/main required for local staging review');
  const report=await reviewSignedStagingRuntime({sha,host,evidenceDir:a[7]});
  console.log(JSON.stringify(report));
  console.log('NOT CERTIFIED: no authorized staging deploy, restore/rollback, TLS edge, field devices or production GO.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED signed staging runtime review: human risk, signed OCI image, host identity or containers not accepted');
    process.exitCode=2;
  });
}
