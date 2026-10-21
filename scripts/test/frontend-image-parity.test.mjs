import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateImageIdentity, verifyCopiedFrontend, verifyFrontendImage
} from '../verify-frontend-image-parity.mjs';

const sha = 'a'.repeat(40);
const imageId = 'sha256:' + 'b'.repeat(64);
const name = 'sedeagro-frontend-rc:' + sha;
const contents = {
  'index.html': '<!doctype html><script type="module" src="/assets/main-1234abcd.js"></script>',
  'sw.js': 'self.addEventListener("install", ()=>{});',
  'assets/main-1234abcd.js': 'console.log("trusted artifact");',
  'assets/main-1234abcd.css': 'body { color: red; }'
};
const nginx = 'server { listen 80; root /usr/share/nginx/html; }\n';
const checksum = data => createHash('sha256').update(data).digest('hex');
function manifest() {
  return { schema: 'sedeagro-staging-build-v1', head: sha,
    files: Object.entries(contents).map(([path,body]) => ({
      path, size:Buffer.byteLength(body),sha256:checksum(body)
    }))
  };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'0p24-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const htmlDir=join(root,'html');
  mkdirSync(join(htmlDir,'assets'),{recursive:true});
  for(const [path,value] of Object.entries(contents)){
    writeFileSync(join(htmlDir,path),value);
  }
  const nginxCopy=join(root,'docker-nginx.conf');
  const nginxReference=join(root,'source-nginx.conf');
  writeFileSync(nginxCopy,nginx);
  writeFileSync(nginxReference,nginx);
  return {root,htmlDir,nginxCopy,nginxReference};
}

test('accepts exact bytes, complete path set, and separately compared Nginx config', t => {
  const f=fixture(t);
  const m=manifest();
  const result=verifyCopiedFrontend({...f,manifest:m,sha});
  assert.equal(result.files_verified,m.files.length);
  assert.equal(result.bytes_verified,m.files.reduce((s,x)=>s+x.size,0));
  assert.equal(result.nginx_sha256,checksum(nginx));
  assert.doesNotMatch(JSON.stringify(result),/console\.log|server/);
});

test('refuses changed JavaScript and service worker even when sizes are unchanged',t=>{
  const f=fixture(t);
  for(const path of ['sw.js','assets/main-1234abcd.js']){
    const filename=join(f.htmlDir,path);
    const old=readFileSync(filename);
    const tampered=Buffer.from(old);
    tampered[0]^=1;
    writeFileSync(filename,tampered);
    assert.equal(lstatSync(filename).size,old.length);
    assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha}),
      /PARITY_BLOCKED/);
    writeFileSync(filename,old);
  }
});

test('blocks missing or unmanifested files, including hidden files', t=>{
  const f=fixture(t);
  const injected=join(f.htmlDir,'.env');
  writeFileSync(injected,'not a secret but must reject');
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha}),/PARITY_BLOCKED/);
  rmSync(injected);
  rmSync(join(f.htmlDir,'sw.js'));
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha}),/PARITY_BLOCKED/);
});

test('blocks symlinks, hardlinks, and special files rather than following them',t=>{
  const f=fixture(t);
  const linked=join(f.htmlDir,'assets/extra.js');
  symlinkSync(join(f.htmlDir,'index.html'),linked);
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha}),/PARITY_BLOCKED/);
  rmSync(linked);
  linkSync(join(f.htmlDir,'index.html'),linked);
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha}),/PARITY_BLOCKED/);
});

test('rejects wrong Nginx config including equal-size mutation and a symlink',t=>{
  const f=fixture(t);
  writeFileSync(f.nginxCopy,nginx.replace('80','81'));
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha}),/PARITY_BLOCKED/);
  rmSync(f.nginxCopy);
  symlinkSync(f.nginxReference,f.nginxCopy);
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha}),/PARITY_BLOCKED/);
});

test('rejects wrong SHA, non-manifest paths and a poisoned manifest before file parity',t=>{
  const f=fixture(t);
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:manifest(),sha:'c'.repeat(40)}),
    /Manifiesto inválido|HEAD/);
  const m=manifest();
  m.files[2].sha256='c'.repeat(64);
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:m,sha}),/PARITY_BLOCKED/);
  const x=manifest();
  x.files[2].path='../private';
  assert.throws(()=>verifyCopiedFrontend({...f,manifest:x,sha}),/inseguro/);
});

test('validates local Docker digest+tag+OCI revision without exposing env',()=>{
  const valid={
    Id:imageId,RepoTags:[name],Config:{
      Labels:{'org.opencontainers.image.revision':sha},
      Env:['JWT_SECRET=NEVER_LOG_THIS']
    }
  };
  assert.deepEqual(validateImageIdentity(valid,sha),
    {image_id:imageId,image_tag:name});
  const wrongs=[
    {...valid,Id:'sha256:bad'},
    {...valid,RepoTags:['sedeagro-frontend-rc:'+'c'.repeat(40)]},
    {...valid,Config:{Labels:{'org.opencontainers.image.revision':'c'.repeat(40)}}},
    {...valid,RepoTags:[]}
  ];
  for(const wrong of wrongs){
    assert.throws(()=>validateImageIdentity(wrong,sha),/PARITY_BLOCKED/);
  }
});

function mockDocker(t,{wrongRevision=false,tamperedFile=false,unexpectedMount=false}={}){
  const f=fixture(t);
  const commands=[];
  const tempPaths=[];
  const id='d'.repeat(64);
  const executor=args=>{
    commands.push(args);
    if(args[0]==='image'){
      return JSON.stringify({
        Id:imageId,RepoTags:[name],Config:{
          Labels:{'org.opencontainers.image.revision':
            wrongRevision?'c'.repeat(40):sha},
          Env:['JWT_SECRET=never-print']
        }
      });
    }
    if(args[0]==='create'){
      assert.deepEqual(args,['create','--network','none','--entrypoint','/bin/true',name]);
      return id+'\n';
    }
    if(args[0]==='cp'){
      const [,,destination]=args;
      tempPaths.push(destination);
      if(args[1].endsWith('/usr/share/nginx/html/.')){
        for(const [path,value] of Object.entries(contents)){
          const d=join(destination,path);
          if(path.includes('/')) mkdirSync(join(destination,'assets'),{recursive:true});
          writeFileSync(d,tamperedFile&&path==='sw.js'?'TAMPERED':value);
        }
        if(unexpectedMount)writeFileSync(join(destination,'.docker-secret'),'forbidden');
      }else{
        writeFileSync(destination,nginx);
      }
      return '';
    }
    if(args[0]==='rm'){
      assert.deepEqual(args,['rm','--force',id]);
      return id+'\n';
    }
    throw Error('unexpected Docker call');
  };
  return {...f,executor,commands,tempPaths};
}

test('inspects exact stopped image, copies files, and removes all temporary evidence',t=>{
  const f=mockDocker(t);
  const result=verifyFrontendImage({
    sha,manifest:manifest(),executor:f.executor,nginxReference:f.nginxReference
  });
  assert.equal(result.status,'CI_IMAGE_PARITY_REVIEW_REQUIRED');
  assert.equal(result.release_sha,sha);
  assert.equal(result.image_id,imageId);
  assert.equal(result.registry_digest_certified,false);
  assert.equal(result.deployed_staging_certified,false);
  assert.deepEqual(f.commands.map(args=>args[0]),['image','create','cp','cp','rm']);
  assert.equal(f.tempPaths.length,2);
  assert.ok(f.tempPaths.every(path=>!existsSync(path)));
  assert.doesNotMatch(JSON.stringify(result),/JWT_SECRET|never-print/);
});

test('no stopped container is created for invalid OCI revision or bad manifest',t=>{
  const f=mockDocker(t,{wrongRevision:true});
  assert.throws(()=>verifyFrontendImage({
    sha,manifest:manifest(),executor:f.executor,nginxReference:f.nginxReference
  }),/PARITY_BLOCKED/);
  assert.deepEqual(f.commands.map(args=>args[0]),['image']);
  const invalid=manifest();invalid.head='c'.repeat(40);
  f.commands.length=0;
  assert.throws(()=>verifyFrontendImage({
    sha,manifest:invalid,executor:f.executor,nginxReference:f.nginxReference
  }),/Manifiesto inválido|HEAD/);
  assert.equal(f.commands.length,0);
});

test('tampered or unmanifested Docker bytes force rollback of stopped inspection container',t=>{
  for(const options of [{tamperedFile:true},{unexpectedMount:true}]){
    const f=mockDocker(t,options);
    assert.throws(()=>verifyFrontendImage({
      sha,manifest:manifest(),executor:f.executor,nginxReference:f.nginxReference
    }),/PARITY_BLOCKED/);
    assert.deepEqual(f.commands.map(args=>args[0]),['image','create','cp','cp','rm']);
    assert.ok(f.tempPaths.every(path=>!existsSync(path)));
  }
});

test('cleanup failure blocks success even after byte parity',t=>{
  const f=mockDocker(t);
  const wrapped=args=>{
    if(args[0]==='rm')throw new Error('simulated Docker cleanup failure');
    return f.executor(args);
  };
  assert.throws(()=>verifyFrontendImage({
    sha,manifest:manifest(),executor:wrapped,nginxReference:f.nginxReference
  }),/cannot remove inspection container/);
  assert.ok(f.tempPaths.every(path=>!existsSync(path)));
});

test('CLI fails closed outside CI before Docker access and never echoes environment secrets',()=>{
  const cli=fileURLToPath(new URL('../verify-frontend-image-parity.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[cli,'--sha',sha],{
    encoding:'utf8',
    env:{...process.env,CI:'false',GITHUB_ACTIONS:'false',
      IMAGE_SHA:sha,JWT_SECRET:'NEVER_LOG_THIS_CI_SECRET'},
    timeout:5000
  });
  assert.equal(r.status,2);
  assert.match(r.stderr,/BLOCKED frontend image parity/);
  assert.doesNotMatch(r.stdout+r.stderr,/NEVER_LOG_THIS_CI_SECRET/);
});

test('workflow requires independent npm ci build AND real image byte parity',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/postgres-isolation.yml',import.meta.url),'utf8');
  const job=workflow.split('  production-images:')[1]?.split('  dependency-security:')[0]||'';
  assert.match(job,/npm --prefix frontend ci/);
  assert.match(job,/npm --prefix frontend run build/);
  assert.match(job,/VITE_API_URL=\/api npm --prefix frontend run build/);
  const browser=workflow.split('  browser-offline:')[1]?.split('  production-images:')[0]||'';
  assert.match(browser,/name: Build production SPA\n\s+env:\n\s+VITE_API_URL: \/api\n\s+run: npm --workspace frontend run build/);
  assert.match(job,/node scripts\/staging-release-manifest.mjs create/);
  assert.match(job,/node scripts\/staging-release-manifest.mjs verify/);
  assert.match(job,/node scripts\/verify-frontend-image-parity.mjs/);
  assert.match(job,/docker build --target prod/);
  assert.doesNotMatch(job,/docker push|docker compose up/);
});
