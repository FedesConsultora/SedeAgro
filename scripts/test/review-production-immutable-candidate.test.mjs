import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reviewImmutableReleaseCandidate } from '../review-production-immutable-candidate.mjs';

const SHA='a'.repeat(40),OTHER='b'.repeat(40);
const ID=s=>'sha256:'+s.repeat(64);
const human=()=>({
  status:'HUMAN_SIGNED_OCI_IMAGE_RISK_REVIEW_NOT_DEPLOYED',
  head:SHA,
  oci_archive_sha256:'c'.repeat(64),
  oci_receipt_sha256:'d'.repeat(64),
  security_receipt_sha256:'e'.repeat(64),
  signer_key_id:'f'.repeat(64),
  security_owner_risk_accepted:true,
  staging_certified:false,other_owners_approved:false,
  production_go:false,time_of_use_certified:false,
  images_loaded:false,containers_created:false
});
const host=()=>({
  status:'HOST_SIGNED_OCI_COMPOSE_PARITY_READONLY_NOT_DEPLOYED',
  head:SHA,oci_archive_sha256:'c'.repeat(64),
  oci_receipt_sha256:'d'.repeat(64),security_receipt_sha256:'e'.repeat(64),
  inspected_image_ids:{backend:ID('1'),frontend:ID('2')},
  immutable_config_ids_bound:true,
  mutable_tag_reference_in_final_plan:false,
  docker_identity_rechecked_after_compose:true,
  preview_uses_synthetic_files:true,
  production_env_read:false,live_compose_config_used:false,
  image_pull_allowed:false,build_allowed:false,
  containers_created:false,containers_started:false,
  security_owner_approved:false,release_go:false,
  time_of_container_create_certified:false,
  staging_deploy_certified:false,production_deploy_certified:false,
  compose_project:'sedeagro'
});
const args=patch=>({
  sha:SHA,evidenceDir:'/synthetic/private/not-mounted',
  checkHuman:async()=>human(),
  checkHost:async()=>host(),
  ...patch
});
test('human-signed risk must be accepted BEFORE touching local Docker',async()=>{
  const order=[];
  const review=await reviewImmutableReleaseCandidate(args({
    checkHuman:async()=>{order.push('ed25519');return human();},
    checkHost:async()=>{order.push('docker-readonly');return host();}
  }));
  assert.deepEqual(order,['ed25519','docker-readonly']);
  assert.equal(review.status,'IMMUTABLE_RELEASE_CANDIDATE_REVIEWED_NOT_DEPLOYED');
  assert.equal(review.head,SHA);
  assert.deepEqual(review.signed_image_ids,host().inspected_image_ids);
  assert.equal(review.compose_image_ref_kind,'sha256-config-id');
  assert.equal(review.security_owner_risk_accepted,true);
  for(const k of ['security_owner_deploy_approved','other_owners_evaluated',
    'staging_certified','production_go','rollback_certified',
    'production_env_read','image_loaded_by_review','containers_created',
    'containers_started','time_of_container_create_certified']){
    assert.equal(review[k],false,k);
  }
});

test('incomplete, forged or overclaimed Security Owner evidence denies before any host read',async()=>{
  for(const edit of [
    {status:'CI_SECURITY_ONLY'}, {head:OTHER},
    {oci_archive_sha256:'bad'}, {oci_receipt_sha256:''},
    {security_receipt_sha256:'bad'},{signer_key_id:'fake'},
    {security_owner_risk_accepted:false},{staging_certified:true},
    {other_owners_approved:true},{production_go:true},
    {time_of_use_certified:true},{images_loaded:true},
    {containers_created:true}
  ]){
    let hostCalls=0;
    await assert.rejects(reviewImmutableReleaseCandidate(args({
      checkHuman:async()=>({...human(),...edit}),
      checkHost:async()=>{hostCalls++;return host();}
    })),/IMMUTABLE_RELEASE_CANDIDATE_BLOCKED/);
    assert.equal(hostCalls,0);
  }
});

test('release candidate requires exact same source, OCI archive, receipt and image-security digests',async()=>{
  for(const edit of [
    {head:OTHER},{oci_archive_sha256:'a'.repeat(64)},
    {oci_receipt_sha256:'a'.repeat(64)},
    {security_receipt_sha256:'b'.repeat(64)},
    {inspected_image_ids:{backend:ID('1'),frontend:ID('1')}},
    {inspected_image_ids:{backend:ID('1'),frontend:'tag:latest'}}
  ]){
    await assert.rejects(reviewImmutableReleaseCandidate(args({
      checkHost:async()=>({...host(),...edit})
    })),/IMMUTABLE_RELEASE_CANDIDATE_BLOCKED/);
  }
});

test('missing immutable Compose proof and unsafe operations deny even with human risk acceptance',async()=>{
  for(const edit of [
    {status:'UNSIGNED_COMPOSE'},
    {immutable_config_ids_bound:false},
    {mutable_tag_reference_in_final_plan:true},
    {docker_identity_rechecked_after_compose:false},
    {preview_uses_synthetic_files:false},
    {production_env_read:true},{live_compose_config_used:true},
    {image_pull_allowed:true},{build_allowed:true},
    {containers_created:true},{containers_started:true},
    {release_go:true},{security_owner_approved:true},
    {time_of_container_create_certified:true},
    {staging_deploy_certified:true},
    {production_deploy_certified:true},
    {compose_project:'foreign-project'}
  ]){
    await assert.rejects(reviewImmutableReleaseCandidate(args({
      checkHost:async()=>({...host(),...edit})
    })),/IMMUTABLE_RELEASE_CANDIDATE_BLOCKED/);
  }
});

test('invalid release SHA and directory deny before any external verification',async()=>{
  for(const input of [
    {sha:'bad'}, {sha:OTHER.toUpperCase()},{evidenceDir:''},
    {evidenceDir:'x'.repeat(4100)}
  ]){
    let calls=0;
    await assert.rejects(reviewImmutableReleaseCandidate(args({
      ...input,
      checkHuman:async()=>{calls++;return human();},
      checkHost:async()=>{calls++;return host();}
    })),/IMMUTABLE_RELEASE_CANDIDATE_BLOCKED/);
    assert.equal(calls,0);
  }
});

test('operator CLI fails closed before host access without explicit SHA-bound review',()=>{
  const cli=fileURLToPath(new URL('../review-production-immutable-candidate.mjs',import.meta.url));
  const env={...process.env,SEDEAGRO_IMMUTABLE_RELEASE_REVIEW:'NO',
    JWT_SECRET:'NEVER_EXPOSE_ME',GH_TOKEN:'NEVER_EXPOSE_ME'};
  for(const extra of [
    [],['--sha',SHA,'--evidence-dir','/unavailable'],
    ['--sha','bad','--evidence-dir','/unavailable']
  ]){
    const result=spawnSync(process.execPath,[cli,...extra],{
      encoding:'utf8',timeout:7000,env
    });
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/BLOCKED immutable release candidate/);
    assert.doesNotMatch(result.stdout+result.stderr,/NEVER_EXPOSE_ME/);
    assert.doesNotMatch(result.stdout,/IMMUTABLE_RELEASE_CANDIDATE_REVIEWED/);
  }
});

test('production rebuild hardstop persists independent of read-only candidate review',()=>{
  const admission=readFileSync(
    new URL('../verify-production-image-admission.mjs',import.meta.url),'utf8');
  const deploy=readFileSync(
    new URL('../deploy-prod.sh',import.meta.url),'utf8');
  assert.match(admission,/export async function inspectSignedImageCandidate/);
  assert.match(admission,/export async function inspectProductionImageAdmission/);
  assert.match(admission,/deploy-prod.sh rebuilds Docker images/);
  assert.match(admission,/deny\('deploy-prod.sh rebuilds Docker images/);
  assert.match(deploy,/docker compose build backend frontend/);
  const source=readFileSync(
    new URL('../review-production-immutable-candidate.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/execFileSync\('docker'/);
  assert.doesNotMatch(source,/\b(?:docker compose up|docker image load|pg_restore --dbname|DROP DATABASE)\b/);
});
