import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {reviewSignedStagingRuntime}
  from '../review-signed-staging-runtime.mjs';

const SHA='a'.repeat(40),OTHER='b'.repeat(40),HOST='staging.ci.test';
const DIGEST=c=>c.repeat(64),ID=c=>'sha256:'+DIGEST(c);
const IMAGES={backend:ID('1'),frontend:ID('2')};
const CONTAINERS={db:DIGEST('3'),redis:DIGEST('4'),
  backend:DIGEST('5'),frontend:DIGEST('6')};
function risk(){return {
  status:'HUMAN_SIGNED_OCI_IMAGE_RISK_REVIEW_NOT_DEPLOYED',
  head:SHA,signer_key_id:DIGEST('a'),
  oci_archive_sha256:DIGEST('b'),
  oci_receipt_sha256:DIGEST('c'),
  security_receipt_sha256:DIGEST('d'),
  security_owner_risk_accepted:true,
  production_go:false,staging_certified:false,
  other_owners_approved:false,time_of_use_certified:false,
  images_loaded:false,containers_created:false
};}
function host(){return {
  status:'HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED',
  head:SHA,
  oci_archive_sha256:DIGEST('b'),
  oci_receipt_sha256:DIGEST('c'),
  security_receipt_sha256:DIGEST('d'),
  local_docker_context:'default',
  inspected_image_ids:{...IMAGES},
  signed_security_inventory_verified:true,
  images_loaded_during_check:false,containers_created:false,
  image_pull_allowed:false,build_allowed:false,
  security_owner_approved:false,release_go:false,
  staging_deploy_certified:false,production_deploy_certified:false,
  time_of_container_create_certified:false
};}
function live(){return {
  status:'RUNTIME_REVIEW_REQUIRED',
  project:'sedeagro-staging',release_sha:SHA,host:HOST,services:4,
  network:'sedeagro-staging_staging_internal',
  image_reference_kind:'immutable-config-id',
  project_container_census_verified:true,
  project_volume_inventory_verified:true,
  image_ids:{db:ID('7'),redis:ID('8'),...IMAGES},
  container_ids:{...CONTAINERS},
  signed_provenance_certified:false,
  registry_digest_certified:false,tls_certified:false,
  database_isolation_certified:false,
  PRIVATE_JWT:'DO_NOT_EXPOSE_SYNTHETIC_SECRET'
};}
const options=edit=>({
  sha:SHA,host:HOST,evidenceDir:'/synthetic/private/not-mounted',
  verifyRisk:async()=>risk(),
  inspectImages:async()=>host(),
  inspectRuntime:async()=>live(),
  ...edit
});

test('real human risk is checked before host Docker, then same four staging containers twice',async()=>{
  const order=[];
  const result=await reviewSignedStagingRuntime(options({
    verifyRisk:async()=>{order.push('human-ed25519');return risk();},
    inspectImages:async()=>{
      order.push('signed-seven-subjects-host');return host();
    },
    inspectRuntime:async({sha,host:hostname,signedImageIds})=>{
      assert.equal(sha,SHA);
      assert.equal(hostname,HOST);
      assert.deepEqual(signedImageIds,IMAGES);
      order.push('four-running-staging-containers');return live();
    }
  }));
  assert.deepEqual(order,[
    'human-ed25519','signed-seven-subjects-host',
    'four-running-staging-containers','signed-seven-subjects-host',
    'four-running-staging-containers'
  ]);
  assert.equal(result.status,
    'SIGNED_OCI_STAGING_RUNTIME_IDENTITIES_REVIEWED_NOT_CERTIFIED');
  assert.deepEqual(result.image_ids,IMAGES);
  assert.equal(result.verified_same_four_containers_twice,true);
  assert.equal(result.checked_running_container_ids,true);
  assert.equal(result.verified_project_volumes_twice,true);
  assert.equal(result.read_only,true);
  assert.equal(result.signed_risk_accepted,true);
  for(const property of [
    'containers_created','containers_started_by_review','production_env_read',
    'staging_tls_certified','staging_db_restore_certified',
    'staging_role_acceptance_certified','staging_certified',
    'security_owner_deploy_approved','production_go',
    'time_of_future_container_creation_certified'
  ])assert.equal(result[property],false,property);
  const serialized=JSON.stringify(result);
  assert.doesNotMatch(serialized,/PRIVATE_JWT|DO_NOT_EXPOSE|JWT_SECRET|DATABASE_URL/);
});

test('forged, mismatched or overclaimed human risk approval fails BEFORE Docker',async()=>{
  const mutations=[
    {status:'CI_SIGNED_ONLY'},{head:OTHER},{signer_key_id:'not a key'},
    {oci_archive_sha256:'notdigest'},
    {oci_receipt_sha256:DIGEST('e').slice(0,8)},
    {security_receipt_sha256:'unsafe'},
    {security_owner_risk_accepted:false},
    {production_go:true},{staging_certified:true},
    {other_owners_approved:true},{time_of_use_certified:true},
    {images_loaded:true},{containers_created:true}
  ];
  for(const mutation of mutations){
    let calls=0;
    await assert.rejects(reviewSignedStagingRuntime(options({
      verifyRisk:async()=>({...risk(),...mutation}),
      inspectImages:async()=>{calls++;return host();},
      inspectRuntime:async()=>{calls++;return live();}
    })),/SIGNED_STAGING_RUNTIME_BLOCKED/);
    assert.equal(calls,0);
  }
});

test('wrong OCI source, security receipt, Docker context or runtime image ID denies',async()=>{
  const mutations=[
    {status:'UNSIGNED'}, {head:OTHER},
    {oci_archive_sha256:DIGEST('7')},
    {oci_receipt_sha256:DIGEST('8')},
    {security_receipt_sha256:DIGEST('9')},
    {local_docker_context:'remote'},
    {signed_security_inventory_verified:false},
    {image_pull_allowed:true}, {build_allowed:true},
    {images_loaded_during_check:true},{containers_created:true},
    {security_owner_approved:true},{release_go:true},
    {staging_deploy_certified:true},
    {production_deploy_certified:true},
    {time_of_container_create_certified:true},
    {inspected_image_ids:{backend:ID('1'),frontend:ID('1')}},
    {inspected_image_ids:{backend:'latest',frontend:ID('2')}},
    {inspected_image_ids:{backend:ID('1'),frontend:ID('2'),extra:ID('3')}}
  ];
  for(const mutation of mutations){
    let runtimeCalls=0;
    await assert.rejects(reviewSignedStagingRuntime(options({
      inspectImages:async()=>({...host(),...mutation}),
      inspectRuntime:async()=>{runtimeCalls++;return live();}
    })),/SIGNED_STAGING_RUNTIME_BLOCKED/);
    assert.equal(runtimeCalls,0);
  }
});

test('unhealthy, wrong project, wrong OCI config reference or overclaimed staging fails',async()=>{
  const edits=[
    {status:'CI_CONFIG_ONLY'},{project:'sedeagro'},
    {release_sha:OTHER},{host:'staging.evil.test'},
    {services:3},{network:'production'},
    {image_reference_kind:'legacy-staging-tag'},
    {project_container_census_verified:false},
    {project_volume_inventory_verified:false},
    {project_volume_inventory_verified:undefined},
    {image_ids:{...IMAGES,backend:ID('f')}},
    {image_ids:{...IMAGES,frontend:ID('f')}},
    {container_ids:{...CONTAINERS,frontend:'bad'}},
    {container_ids:{...CONTAINERS,frontend:CONTAINERS.backend}},
    {container_ids:{...CONTAINERS,other:DIGEST('f')}},
    {signed_provenance_certified:true},
    {registry_digest_certified:true},{tls_certified:true},
    {database_isolation_certified:true}
  ];
  for(const edit of edits){
    await assert.rejects(reviewSignedStagingRuntime(options({
      inspectRuntime:async()=>({...live(),...edit})
    })),/SIGNED_STAGING_RUNTIME_BLOCKED/);
  }
});

test('second host signature/ID check and second container inspection catch concurrent replacement',async()=>{
  const changes=[
    {oci_receipt_sha256:DIGEST('e')},
    {inspected_image_ids:{backend:ID('1'),frontend:ID('a')}},
    {images_loaded_during_check:true},{status:'DRIFTED'}
  ];
  for(const edit of changes){
    let inspections=0;
    await assert.rejects(reviewSignedStagingRuntime(options({
      inspectImages:async()=>++inspections===1?host():{...host(),...edit}
    })),/SIGNED_STAGING_RUNTIME_BLOCKED/);
    assert.equal(inspections,2);
  }
  const swapped={...CONTAINERS,frontend:DIGEST('f')};
  let inspect=0;
  await assert.rejects(reviewSignedStagingRuntime(options({
    inspectRuntime:async()=>++inspect===1?live():
      {...live(),container_ids:swapped}
  })),/SIGNED_STAGING_RUNTIME_BLOCKED/);
  assert.equal(inspect,2);
});

test('signed review cannot accept a missing volume scan or changed inventory between rounds',async()=>{
  let calls=0;
  await assert.rejects(reviewSignedStagingRuntime(options({
    inspectRuntime:async()=>{
      calls++;
      return calls===1?live():{...live(),project_volume_inventory_verified:false};
    }
  })),/SIGNED_STAGING_RUNTIME_BLOCKED/);
  assert.equal(calls,2);
});

test('invalid staging hostname or SHA cannot reach human review or Docker',async()=>{
  for(const edit of [
    {sha:'short'}, {sha:OTHER,host:'sedeagro.fedes.ai'},
    {host:'staging.invalid'},{host:'staging..evil.test'},
    {evidenceDir:''}
  ]){
    let invoked=false;
    await assert.rejects(reviewSignedStagingRuntime(options({
      ...edit,verifyRisk:async()=>{invoked=true;return risk();}
    })));
    assert.equal(invoked,false);
  }
});

test('operator CLI is read-only, requires explicit intent and disallows inherited host overrides',()=>{
  const script=fileURLToPath(new URL('../review-signed-staging-runtime.mjs',
    import.meta.url));
  const args=['--sha',SHA,'--host',HOST,'--evidence-dir',
    '/private/nonexistent-synthetic'];
  for(const override of [
    {SEDEAGRO_SIGNED_STAGING_REVIEW:'NO'},
    {SEDEAGRO_SIGNED_STAGING_REVIEW:'REVIEW:'+OTHER},
    {SEDEAGRO_SIGNED_STAGING_REVIEW:'REVIEW:'+SHA,DOCKER_HOST:'tcp://remote:2375'},
    {SEDEAGRO_SIGNED_STAGING_REVIEW:'REVIEW:'+SHA,COMPOSE_FILE:'other.yml'}
  ]){
    const run=spawnSync(process.execPath,[script,...args],{
      env:{...process.env,...override,SYNTHETIC_SECRET:'DO_NOT_LOG_THIS'},
      encoding:'utf8',timeout:5000
    });
    assert.equal(run.status,2,run.stderr);
    assert.match(run.stderr,/BLOCKED signed staging runtime review/);
    assert.doesNotMatch(run.stdout+run.stderr,/DO_NOT_LOG_THIS|remote:2375/);
  }
  const malformed=spawnSync(process.execPath,[script,...args,
    '--signed-image-id',ID('1')],{
    encoding:'utf8',timeout:5000,
    env:{...process.env,SEDEAGRO_SIGNED_STAGING_REVIEW:'REVIEW:'+SHA}
  });
  assert.equal(malformed.status,2);
  assert.match(malformed.stderr,/BLOCKED signed staging runtime review/);
});

test('real CLI is composed exclusively from read-only Docker inspections',()=>{
  const script=readFileSync(new URL('../review-signed-staging-runtime.mjs',
    import.meta.url),'utf8');
  assert.match(script,/inspectSignedImageCandidate/);
  assert.match(script,/inspectHostSignedImages/);
  assert.match(script,/inspectStagingRuntime/);
  assert.doesNotMatch(script,/docker compose up|docker container run|docker image load/);
  assert.doesNotMatch(script,/execFileSync\('bash'/);
  assert.doesNotMatch(script,/console\.log\(.*Config\.Env/);
});
