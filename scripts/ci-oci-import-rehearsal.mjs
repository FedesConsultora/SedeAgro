// 0P.26: networkless, non-deploy CI Docker-save import acceptance.
// Input is always verified offline before modifying the disposable Docker store.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReceipt } from './oci-release-bundle.mjs';

const HEAD = /^[a-f0-9]{40}$/;
const ID = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SERVICES = ['backend', 'frontend'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function block(reason) { throw new Error('OCI_IMPORT_BLOCKED: ' + reason); }
function requireSafe(ok, reason) { if (!ok) block(reason); }
const docker = args => execFileSync('docker',args,{
  encoding:'utf8',timeout:args[1]==='load'?240000:20000,
  maxBuffer:512*1024,stdio:['ignore','pipe','pipe']
});

export function validateImportedImage(image, expected, sha) {
  requireSafe(HEAD.test(sha||'') &&
    SERVICES.includes(expected?.service) &&
    expected.tag==='sedeagro-'+expected.service+'-rc:'+sha &&
    ID.test(expected.config_id||'') &&
    expected.os==='linux' && expected.architecture==='amd64' &&
    Array.isArray(expected.layers) && expected.layers.length>0 &&
    expected.layers.every(x=>ID.test(x)),
  'trusted image descriptor invalid');
  requireSafe(image?.Id===expected.config_id &&
    image.Os===expected.os && image.Architecture===expected.architecture &&
    image.Config?.Labels?.['org.opencontainers.image.revision']===sha &&
    Array.isArray(image.RepoTags) && image.RepoTags.includes(expected.tag) &&
    JSON.stringify(image.RootFS?.Layers)===JSON.stringify(expected.layers),
  'Docker image config, layers, tag or OCI revision mismatch');
  if(expected.service==='backend') {
    requireSafe(Array.isArray(image.Config?.Env) &&
      image.Config.Env.includes('SEDEAGRO_BUILD_SHA='+sha),
    'backend embedded SHA differs');
  }
  return expected.config_id;
}
function inspect(execute,tag) {
  const output=execute(['image','inspect','--format','{{json .}}',tag]);
  requireSafe(typeof output==='string' && output.length>0 &&
    output.length<512*1024,'invalid image inspect output');
  try{return JSON.parse(output);}catch{block('invalid Docker image metadata JSON');}
}
function absent(execute,tag) {
  // A daemon failure must THROW, not be misread as an absent image tag.
  const out=execute(['image','ls','--quiet','--no-trunc','--filter','reference='+tag]);
  requireSafe(typeof out==='string' && out.length<=512,'image list invalid');
  return out.trim()==='';
}

export async function rehearseImageImport({sha,bundlePath,receiptPath,mode,
  execute=docker,verify=verifyReceipt}={}) {
  requireSafe(HEAD.test(sha||'') && ['fresh','replace'].includes(mode),
    'exact SHA and CI-only import mode required');
  const evidence=await verify({bundlePath,receiptPath,sha});
  requireSafe(evidence?.status==='OFFLINE_BUNDLE_VERIFIED_NOT_DEPLOYED' &&
    evidence.head===sha && SHA256.test(evidence.archive_sha256||'') &&
    evidence.registry_digest_certified===false &&
    evidence.signed_provenance_certified===false &&
    SERVICES.every(name=>ID.test(evidence.image_ids?.[name]||'')),
  'archive must pass complete offline verifier before Docker is touched');
  let receipt;
  try {receipt=JSON.parse(readFileSync(receiptPath,'utf8'));}
  catch {block('verified receipt is unreadable');}
  requireSafe(receipt?.head===sha &&
    receipt.archive?.sha256===evidence.archive_sha256 &&
    Array.isArray(receipt.images) && receipt.images.length===2 &&
    receipt.images.every((im,i)=>im.service===SERVICES[i] &&
      im.config_id===evidence.image_ids[im.service]),
  'receipt descriptors differ from verified TAR');
  const images=receipt.images;
  if(mode==='fresh') {
    for(const im of images)requireSafe(absent(execute,im.tag),
      'fresh runner already has release tag; import isolation invalid');
  } else {
    for(const im of images) {
      requireSafe(!absent(execute,im.tag),'producer image tag absent');
      validateImportedImage(inspect(execute,im.tag),im,sha);
    }
    for(const im of images)execute(['image','rm','--no-prune',im.tag]);
    for(const im of images)requireSafe(absent(execute,im.tag),
      'producer image tag survived controlled removal');
  }
  // Only imports locally: no Docker run/start, ports, registry or remote hosts.
  execute(['image','load','--input',bundlePath]);
  for(const im of images) {
    requireSafe(!absent(execute,im.tag),'import did not restore image tag');
    validateImportedImage(inspect(execute,im.tag),im,sha);
  }
  return {
    status:'CI_OCI_IMPORT_REHEARSAL_VERIFIED_NOT_DEPLOYED',
    mode,head:sha,archive_sha256:evidence.archive_sha256,
    imported_images:Object.fromEntries(images.map(im=>[im.service,im.config_id])),
    independent_runner:mode==='fresh',
    signed_provenance_certified:false,registry_digest_certified:false,
    staging_deployment_certified:false
  };
}
function argumentsFromCli(argv) {
  requireSafe(argv.length===10 && argv[2]==='--mode' &&
    ['fresh','replace'].includes(argv[3]) && argv[4]==='--sha' &&
    argv[6]==='--bundle' && argv[8]==='--receipt',
  'only --mode fresh|replace --sha SHA --bundle TAR --receipt JSON');
  return {mode:argv[3],sha:argv[5],bundlePath:resolve(argv[7]),
    receiptPath:resolve(argv[9])};
}
async function main() {
  const args=argumentsFromCli(process.argv);
  requireSafe(process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true' &&
    HEAD.test(args.sha||'') && process.env.IMAGE_SHA===args.sha,
  'only exact-SHA GitHub CI permits import rehearsal');
  const head=execFileSync('git',['rev-parse','HEAD'],
    {cwd:ROOT,encoding:'utf8',timeout:5000}).trim();
  requireSafe(head===args.sha,'checkout and release SHA differ');
  const dir=resolve(process.env.RUNNER_TEMP||'/invalid-runner-temp','sedeagro-oci');
  requireSafe(dirname(args.bundlePath)===dir &&
    dirname(args.receiptPath)===dir &&
    basename(args.bundlePath)==='sedeagro-images-'+args.sha+'.tar' &&
    basename(args.receiptPath)==='sedeagro-images-'+args.sha+'.json',
  'only fixed private CI artifacts accepted');
  for(const path of [args.bundlePath,args.receiptPath]) {
    const s=lstatSync(path);
    requireSafe(s.isFile() && !s.isSymbolicLink() &&
      s.nlink===1 && s.size>0,'unsafe or missing release input');
  }
  const result=await rehearseImageImport(args);
  console.log(JSON.stringify(result));
  console.log('NOT CERTIFIED: registry digest, signed provenance, staging or production.');
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  main().catch(()=>{
    // Never log Docker stderr, data, local paths or environment variables.
    console.error('BLOCKED CI OCI import: invalid TAR, receipt, Docker or release identity');
    process.exitCode=2;
  });
}
