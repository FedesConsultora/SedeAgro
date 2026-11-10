import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  rehearseRunningImageProcesses,backendProbe,frontendProbe
} from '../ci-oci-running-image-smoke.mjs';

const SHA='a'.repeat(40),OTHER='b'.repeat(40);
const id=c=>'sha256:'+c.repeat(64);
const images=['backend','frontend'].map((service,i)=>({
  service,tag:'sedeagro-'+service+'-rc:'+SHA,
  config_id:id(i?'d':'c')
}));
const receipt={
  head:SHA,archive:{name:'sedeagro-images-'+SHA+'.tar',sha256:'e'.repeat(64)},
  images
};
const reviewed=()=>({
  status:'CI_OCI_IMMUTABLE_ID_PRODUCTION_COMPOSE_RESOLVED_NOT_DEPLOYED',
  head:SHA,archive_sha256:receipt.archive.sha256,
  uses_config_ids:true,referenced_mutable_tags:false,
  real_production_compose_checked:true,
  immutable_images:{backend:images[0].config_id,frontend:images[1].config_id},
  containers_created:false,containers_started:false,
  production_go:false,security_owner_approved:false,staging_certified:false,
  time_of_use_certified:false
});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-oci-running-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const receiptPath=join(dir,'sedeagro-images-'+SHA+'.json'),
    bundlePath=join(dir,'sedeagro-images-'+SHA+'.tar');
  writeFileSync(receiptPath,JSON.stringify(receipt));
  writeFileSync(bundlePath,'FAKE TAR NOT USED BY INJECTED REVIEW');
  return {dir,receiptPath,bundlePath};
}
function fakeDocker(options={}){
  const calls=[],seen={run:[],check:[]},leftovers=new Set();
  return {
    calls,seen,
    execute(args){
      calls.push(args);
      if(args[0]==='container'&&args[1]==='run'){
        assert.ok(args.includes('--rm')&&args.includes('--pull=never'));
        assert.ok(args.includes('--read-only')&&args.includes('--network=none'));
        assert.ok(args.includes('--cap-drop=ALL'));
        assert.ok(args.includes('--security-opt=no-new-privileges'));
        assert.ok(args.includes('--pids-limit=64'));
        assert.ok(args.includes('--memory=256m'));
        assert.ok(!args.some(x=>['-p','--publish','--privileged',
          '--network=host','--network=bridge','-v','--volume','--mount',
          '--device'].includes(x)));
        const name=args[args.indexOf('--name')+1];
        assert.match(name,/^sedeagro-ci-oci-(?:backend|frontend)-[a-f0-9]{12}$/);
        const service=name.includes('-backend-')?'backend':'frontend';
        const im=images.find(x=>x.service===service);
        assert.ok(args.includes(im.config_id));
        assert.ok(!args.includes(im.tag),'never use the mutable tag');
        assert.ok(args.includes('--tmpfs')&&args.includes('/tmp:rw,nosuid,nodev,size=16m'));
        if(service==='backend'){
          assert.ok(args.includes('NODE_ENV=production'));
          assert.ok(args.includes('JWT_SECRET=CIOnlyIsolatedRuntimeKey1234567890abcdef'));
          assert.ok(args.includes('DATABASE_URL=postgres://isolated:ci@127.0.0.1:5432/absent'));
          assert.ok(args.includes('node'));
          assert.ok(args.some(x=>x.includes('/health/revision')&&x.includes('/health/ready')));
        }else{
          assert.ok(args.includes('sedeagro_backend:127.0.0.1'));
          assert.ok(args.includes('/var/cache/nginx:rw,nosuid,nodev,size=16m'));
          assert.ok(args.some(x=>x.includes('nginx -t')&&x.includes('/usr/share/nginx/html/index.html')));
        }
        seen.run.push(service);
        if(options.leaveBehind===service)leftovers.add(name);
        if(options.failRun===service){
          const e=new Error('DO_NOT_PRINT_RAW_DOCKER_MESSAGE');
          e.status=13;
          e.stderr=options.marker||'DO_NOT_PRINT_DOCKER_STDERR';
          throw e;
        }
        return options.badOutput===service?'WRONG_PROCESS_OUTPUT':
          service==='backend'?'CI_OCI_BACKEND_HEALTH_OK:'+SHA+'\n':
            'CI_OCI_FRONTEND_NGINX_CONFIG_OK\n';
      }
      if(args[0]==='container'&&args[1]==='ls'){
        const filter=args.at(-1);
        const name=filter.split('name=^/')[1]?.replace(/\$$/,'');
        seen.check.push(name);
        return leftovers.has(name)?'f'.repeat(64)+'\n':'';
      }
      if(args[0]==='container'&&args[1]==='rm'){
        const name=args.at(-1);
        if(options.failCleanup)throw new Error('bad cleanup');
        leftovers.delete(name);
        return name;
      }
      throw new Error('unexpected Docker operation '+args.join(' '));
    }
  };
}
function args(t,opts={}){
  const f=fixture(t),d=fakeDocker(opts);
  return {...f,sha:SHA,review:async()=>reviewed(),
    execute:d.execute,suffix:()=>'a'.repeat(12),trace:d};
}

test('exact signed ID boot checks real Express and Nginx; never CI staging or production GO',async t=>{
  const a=args(t);
  const report=await rehearseRunningImageProcesses(a);
  assert.equal(report.status,'CI_OCI_NETWORKLESS_RUNTIME_SMOKE_SUCCESS_NOT_DEPLOYED');
  assert.deepEqual(report.executed_image_ids,reviewed().immutable_images);
  assert.deepEqual(a.trace.seen.run,['backend','frontend']);
  assert.equal(a.trace.seen.check.length,2);
  for(const flag of ['real_express_liveness','real_revision_matches_signed_image',
    'readiness_without_database_is_unavailable','frontend_static_assets_present',
    'real_nginx_config_valid','all_disposable_containers_removed']){
    assert.equal(report[flag],true,flag);
  }
  for(const flag of ['network_created','ports_exposed','host_data_mounted',
    'image_pull_allowed','image_build_allowed','production_go',
    'staging_certified','security_owner_approved','production_cutover_tested']){
    assert.equal(report[flag],false,flag);
  }
  assert.ok(a.trace.calls.every(x=>x[0]==='container'));
});

test('processes cannot run unless exact read-only imported OCI Compose proof is present',async t=>{
  const inputs=[
    {status:'WRONG'},{head:OTHER},{archive_sha256:'x'},
    {uses_config_ids:false},{referenced_mutable_tags:true},
    {real_production_compose_checked:false},
    {immutable_images:{backend:id('1'),frontend:id('1')}},
    {immutable_images:{backend:'mutable:tag',frontend:id('d')}},
    {containers_created:true},{containers_started:true},
    {production_go:true},{security_owner_approved:true},
    {staging_certified:true},{time_of_use_certified:true}
  ];
  for(const edit of inputs){
    const a=args(t);
    await assert.rejects(rehearseRunningImageProcesses({
      ...a,review:async()=>({...reviewed(),...edit})
    }),/OCI_NETWORKLESS_PROCESS_BLOCKED/);
    assert.equal(a.trace.calls.length,0);
  }
});

test('tampered receipt or image selection denies without running anything',async t=>{
  const a=args(t);
  for(const edit of [
    {...receipt,head:OTHER},
    {...receipt,archive:{...receipt.archive,sha256:'f'.repeat(64)}},
    {...receipt,images:[images[0],{...images[1],config_id:id('4')}]},
    {...receipt,images:[{...images[0],tag:'unreviewed'},images[1]]},
    {...receipt,images:[images[1],images[0]]}
  ]){
    writeFileSync(a.receiptPath,JSON.stringify(edit));
    await assert.rejects(rehearseRunningImageProcesses(a),
      /OCI_NETWORKLESS_PROCESS_BLOCKED/);
    assert.equal(a.trace.calls.length,0);
  }
});

test('actual runtime failure, output mismatch and cleanup failures deny',async t=>{
  for(const opts of [
    {failRun:'backend'}, {failRun:'frontend'},
    {badOutput:'backend'}, {badOutput:'frontend'},
    {leaveBehind:'backend'}, {leaveBehind:'frontend'},
    {leaveBehind:'backend',failCleanup:true}
  ]){
    const a=args(t,opts);
    await assert.rejects(rehearseRunningImageProcesses(a),
      /OCI_NETWORKLESS_PROCESS_BLOCKED/);
    assert.ok(a.trace.seen.check.length>0,
      'failure must inspect disposable containers for cleanup');
  }
});

test('failed runtime emits only authored stage and numeric exit, never raw Docker stderr',async t=>{
  for(const [service,marker,expected] of [
    ['backend','CI_OCI_BACKEND_PROBE_STAGE:revision\\nEXPOSE_NO_VALUE','backend process exit=13 stage=revision'],
    ['backend','CI_OCI_BACKEND_PROBE_STAGE:readiness\\nEXPOSE_NO_VALUE','backend process exit=13 stage=readiness'],
    ['frontend','CI_OCI_FRONTEND_NGINX_CONFIG_STAGE:syntax\\nEXPOSE_NO_VALUE','frontend process exit=13 stage=syntax']
  ]){
    const a=args(t,{failRun:service,marker});
    await assert.rejects(rehearseRunningImageProcesses(a),error=>{
      assert.match(error.message,new RegExp(expected));
      assert.doesNotMatch(error.message,/EXPOSE_NO_VALUE|DO_NOT_PRINT/);
      return true;
    });
  }
});

test('source probes bind exact revision, fail closed without DB, and check Nginx/SPA assets',()=>{
  assert.match(backendProbe,/createApp/);
  assert.match(backendProbe,/\/health\/revision/);
  assert.match(backendProbe,/\/health\/ready/);
  assert.match(backendProbe,/ready.status!==503/);
  assert.match(backendProbe,/process.env.SEDEAGRO_BUILD_SHA/);
  assert.match(frontendProbe,/nginx -t/);
  assert.match(frontendProbe,/\/usr\/share\/nginx\/html\/sw.js/);
  assert.match(frontendProbe,/CI_OCI_FRONTEND_NGINX_CONFIG_OK/);
  const images=readFileSync(new URL('../ci-oci-running-image-smoke.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(images,/execFileSync\('bash'/);
  assert.doesNotMatch(images,/docker compose up|docker image pull|docker build/);
});

test('CLI never runs locally or on pull requests even with synthetically supplied artifact names',t=>{
  const {bundlePath,receiptPath}=fixture(t);
  const cli=fileURLToPath(new URL('../ci-oci-running-image-smoke.mjs',import.meta.url));
  for(const env of [
    {CI:'false',GITHUB_ACTIONS:'false'},
    {CI:'true',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',
      GITHUB_REF:'refs/pull/1/merge',GITHUB_REPOSITORY:'FedesConsultora/SedeAgro',
      IMAGE_SHA:SHA}
  ]){
    const out=spawnSync(process.execPath,[cli,'--sha',SHA,'--bundle',
      bundlePath,'--receipt',receiptPath],{
      encoding:'utf8',timeout:5000,env:{...process.env,...env,
        JWT_SECRET:'DO_NOT_PRINT_CI_SECRET'}
    });
    assert.equal(out.status,2,out.stderr);
    assert.match(out.stderr,/BLOCKED OCI runtime smoke/);
    assert.doesNotMatch(out.stdout+out.stderr,/DO_NOT_PRINT_CI_SECRET/);
  }
});

test('receiver invokes runtime smoke only AFTER signed import and immutable ID proof',()=>{
  const workflow=readFileSync(
    new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const job=workflow.split('  offline-image-import:')[1]||'';
  const signed=job.indexOf('verify-oci-signed-provenance.mjs --sha');
  const imported=job.indexOf('ci-oci-import-rehearsal.mjs --mode fresh');
  const locked=job.indexOf('ci-oci-immutable-runtime-compose.mjs --sha');
  const running=job.indexOf('ci-oci-running-image-smoke.mjs --sha');
  assert.ok(signed>=0&&imported>signed&&locked>imported&&running>locked);
  assert.match(job,/runs-on: ubuntu-24.04/);
  assert.match(job,/if: github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
});
