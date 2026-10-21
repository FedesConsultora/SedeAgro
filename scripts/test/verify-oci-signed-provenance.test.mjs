import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  attestationArgs, validateVerifiedAttestation, verifySignedRelease
} from '../verify-oci-signed-provenance.mjs';

const SHA='a'.repeat(40);
const TAR_DIGEST='b'.repeat(64);
const PREDICATE='https://slsa.dev/provenance/v1';
const REPO='FedesConsultora/SedeAgro';
const SIGNER=REPO+'/.github/workflows/postgres-isolation.yml';
const hash=x=>createHash('sha256').update(x).digest('hex');

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sedeagro-0p27-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const bundlePath=join(dir,'sedeagro-images-'+SHA+'.tar');
  const receiptPath=join(dir,'sedeagro-images-'+SHA+'.json');
  writeFileSync(bundlePath,'synthetic -- a fake archive accepted only by injected fixture');
  writeFileSync(receiptPath,JSON.stringify({head:SHA,archive:{sha256:TAR_DIGEST}})+'\n');
  return {bundlePath,receiptPath,receiptSha:hash(readFileSync(receiptPath))};
}
const preflight=async()=>({
  status:'OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED',head:SHA,
  archive_sha256:TAR_DIGEST,registry_digest_certified:false,
  signed_provenance_certified:false
});
function signedResult(name,digest,mutations={}) {
  return JSON.stringify([{
    attestation:{mediaType:'application/vnd.dev.sigstore.bundle.v0.3+json'},
    verificationResult:{
      signature:{certificate:{sourceRepository:REPO}},
      verifiedTimestamps:[{type:'transparency-log'}],
      statement:{predicateType:PREDICATE,
        subject:[{name,digest:{sha256:digest}}]},
      ...mutations
    }
  }]);
}
function signedExecutor(f,cmds=[]) {
  return args=>{
    cmds.push([...args]);
    const name=basename(args[2]);
    const digest=name.endsWith('.tar')?TAR_DIGEST:f.receiptSha;
    return signedResult(name,digest);
  };
}

test('exact gh signer identity, source SHA/ref, Sigstore policy and no runner self-hosted',()=>{
  const path='/tmp/sedeagro-images-'+SHA+'.tar';
  assert.deepEqual(attestationArgs(path,SHA),[
    'attestation','verify',path,
    '--repo',REPO,'--signer-workflow',SIGNER,
    '--source-ref','refs/heads/main',
    '--source-digest',SHA,
    '--predicate-type',PREDICATE,
    '--deny-self-hosted-runners',
    '--format','json'
  ]);
  assert.throws(()=>attestationArgs(path,'bad'),/SIGNED_OCI_PROVENANCE_BLOCKED/);
});

test('valid exact workflow signed artifacts accepted only after offline receipt preflight',async t=>{
  const f=fixture(t),calls=[];
  const result=await verifySignedRelease({...f,sha:SHA,verify:preflight,
    execute:signedExecutor(f,calls)});
  assert.equal(result.status,'GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED');
  assert.equal(result.github_oidc_signature_checked,true);
  assert.equal(result.head,SHA);
  assert.equal(result.repository,REPO);
  assert.equal(result.signer_workflow,SIGNER);
  assert.deepEqual(result.subjects,[
    {name:basename(f.bundlePath),sha256:TAR_DIGEST},
    {name:basename(f.receiptPath),sha256:f.receiptSha}
  ]);
  assert.equal(result.signed_registry_image_digest_certified,false);
  assert.equal(result.staging_deployment_certified,false);
  assert.equal(calls.length,2);
  assert.ok(calls.every(args=>args.includes('--deny-self-hosted-runners') &&
    args.includes('refs/heads/main') && args.includes(SIGNER)));
});

test('failed offline TAR verification blocks all network attestation queries',async t=>{
  const f=fixture(t);let called=0;
  const execute=()=>{called++;return '{}';};
  for(const verify of [
    async()=>{throw Error('one TAR layer corrupted');},
    async()=>({...await preflight(),head:'c'.repeat(40)}),
    async()=>({...await preflight(),status:'FAKE_SUCCESS'}),
    async()=>({...await preflight(),signed_provenance_certified:true})
  ]) {
    await assert.rejects(verifySignedRelease({...f,sha:SHA,verify,execute}));
  }
  assert.equal(called,0);
});

test('wrong signature subject hash is rejected even if gh CLI returns exit zero',async t=>{
  const f=fixture(t);
  await assert.rejects(verifySignedRelease({...f,sha:SHA,verify:preflight,
    execute:args=>signedResult(basename(args[2]),'c'.repeat(64))}),
    /verified SLSA statement/);
});

test('tampered receipt bytes invalidate signed receipt subject',async t=>{
  const f=fixture(t),oldSha=f.receiptSha;
  writeFileSync(f.receiptPath,'{"head":"new","archive":{"sha256":"tampered"}}');
  await assert.rejects(verifySignedRelease({...f,sha:SHA,verify:preflight,
    execute:args=>signedResult(basename(args[2]),
      basename(args[2]).endsWith('.tar')?TAR_DIGEST:oldSha)}),
  /verified SLSA statement/);
});

test('no verified statement, missing timestamp or unsigned certificate all fail',()=>{
  const name='sedeagro-images-'+SHA+'.tar';
  const ok=signedResult(name,TAR_DIGEST);
  assert.equal(validateVerifiedAttestation(ok,{name,digest:TAR_DIGEST}).sha256,TAR_DIGEST);
  for(const input of [
    '', '{}', '[]', 'not-json',
    signedResult(name,TAR_DIGEST,{verifiedTimestamps:[]}),
    signedResult(name,TAR_DIGEST,{signature:{certificate:null}}),
    signedResult(name,TAR_DIGEST,{statement:{subject:[],
      predicateType:PREDICATE}}),
    signedResult(name,TAR_DIGEST,{statement:{subject:[{name,digest:{sha256:TAR_DIGEST}}],
      predicateType:'https://other.example/predicate'}})
  ])assert.throws(()=>validateVerifiedAttestation(input,{name,digest:TAR_DIGEST}),
    /SIGNED_OCI_PROVENANCE_BLOCKED/);
});

test('attestation output cannot be substituted with another file name',async t=>{
  const f=fixture(t);
  await assert.rejects(verifySignedRelease({...f,sha:SHA,verify:preflight,
    execute:()=>signedResult('other.tar',TAR_DIGEST)}),
  /verified SLSA statement/);
});

test('gh CLI fetch or cryptographic verification failure does not admit artifact',async t=>{
  const f=fixture(t);
  await assert.rejects(verifySignedRelease({...f,sha:SHA,verify:preflight,
    execute:()=>{throw Error('signature invalid or certificate untrusted');}}),
  /signature invalid/);
});

test('symlinked receipt is rejected before shell and GH CLI',async t=>{
  const f=fixture(t);
  const other=join(f.bundlePath+'.elsewhere');
  writeFileSync(other,'{"fake":true}');
  rmSync(f.receiptPath);
  symlinkSync(other,f.receiptPath);
  let ghCalls=0;
  await assert.rejects(verifySignedRelease({...f,sha:SHA,verify:preflight,
    execute:()=>{ghCalls++;return '';}}),
  /bounded regular file/);
  assert.equal(ghCalls,0);
});

test('CLI fails closed on a non-main or non-GitHub runner without leaking secret',()=>{
  const cli=fileURLToPath(new URL('../verify-oci-signed-provenance.mjs',import.meta.url));
  const p=spawnSync(process.execPath,[cli,'--sha',SHA,
    '--bundle','/tmp/unknown.tar','--receipt','/tmp/unknown.json'],{
    encoding:'utf8',timeout:6000,env:{
      ...process.env,CI:'false',GITHUB_ACTIONS:'false',
      GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/heads/main',
      GITHUB_REPOSITORY:REPO,IMAGE_SHA:SHA,
      JWT_SECRET:'NEVER_LOG_THIS_CREDENTIAL'
    }
  });
  assert.equal(p.status,2);
  assert.match(p.stderr,/BLOCKED signed OCI provenance/);
  assert.doesNotMatch(p.stdout+p.stderr,/NEVER_LOG_THIS_CREDENTIAL/);
});

test('workflow signs only integrated main in a narrowly privileged separate job',()=>{
  const w=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const signer=w.split('  attest-oci-bundle:')[1]?.split('  offline-image-import:')[0]||'';
  const receiver=w.split('  offline-image-import:')[1]||'';
  const producer=w.split('  production-images:')[1]?.split('  dependency-security:')[0]||'';
  assert.match(signer,/github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(signer,/needs: production-images/);
  assert.match(signer,/id-token: write/);
  assert.match(signer,/attestations: write/);
  assert.match(signer,/artifact-metadata: write/);
  assert.match(signer,/actions\/attest@v4/);
  assert.match(signer,/sedeagro-images-\$\{\{ github\.sha \}\}\.tar/);
  assert.match(signer,/sedeagro-images-\$\{\{ github\.sha \}\}\.json/);
  assert.match(receiver,/needs: \[production-images, attest-oci-bundle\]/);
  assert.match(receiver,/node scripts\/verify-oci-signed-provenance\.mjs/);
  const signedIdx=receiver.indexOf('node scripts/verify-oci-signed-provenance.mjs');
  const importIdx=receiver.indexOf('node scripts/ci-oci-import-rehearsal.mjs');
  assert.ok(signedIdx>=0 && importIdx>signedIdx,'must verify signer before docker load');
  assert.doesNotMatch(producer,/id-token: write|attestations: write/);
  assert.doesNotMatch(receiver,/id-token: write|attestations: write/);
});
