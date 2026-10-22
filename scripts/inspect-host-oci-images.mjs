// 0P.39: read-only Linux host diagnostic for EXISTING signed OCI images.
// No docker load/create/start/run/up/pull/build, no production release admission.
// The image-id check is NOT a time-of-container-create guarantee.
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySignedRelease} from './verify-oci-signed-provenance.mjs';
import {verifySecuritySignatures} from './verify-image-security.mjs';
import {verifiedReleaseRiskContext} from './verify-release-owner-approval.mjs';
import {validateImportedImage} from './ci-oci-import-rehearsal.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{40}$/, ID=/^sha256:[a-f0-9]{64}$/;
const SERVICES=['backend','frontend'];
const STATUS='HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED';
function block(reason){throw new Error('HOST_OCI_READONLY_BLOCKED: '+reason);}
function check(ok,reason){if(!ok)block(reason);}
function privateDir(value){
  check(typeof value==='string'&&value.length>0&&value.length<4096,
    'missing dedicated evidence directory');
  const dir=resolve(value),stat=lstatSync(dir);
  check(stat.isDirectory()&&!stat.isSymbolicLink()&&
    (stat.mode&0o077)===0&&
    (typeof process.getuid!=='function'||stat.uid===process.getuid())&&
    realpathSync(dir)===dir&&dir!==ROOT&&!dir.startsWith(ROOT+'/'),
    'release evidence directory must be canonical, private and outside checkout');
  return dir;
}
function readReceipt(file,sha){
  check(basename(file)==='sedeagro-images-'+sha+'.json',
    'release receipt filename differs from SHA');
  const st=lstatSync(file);
  check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&
    st.size>10&&st.size<65536,'release receipt is unsafe or unbounded');
  return readFileSync(file);
}
function json(raw,reason){
  check(typeof raw==='string'&&raw.length>1&&raw.length<512*1024,
    reason+' missing or oversized');
  try{return JSON.parse(raw);}catch{block(reason+' invalid JSON');}
}
const command=args=>execFileSync('docker',args,{
  encoding:'utf8',timeout:15000,maxBuffer:512*1024,
  // Refuse inherited DOCKER_HOST/CONTEXT/TLS overrides. Linux default only.
  env:{PATH:process.env.PATH,HOME:process.env.HOME},
  stdio:['ignore','pipe','pipe']
});
export function validateLocalDockerContext(execute){
  const context=execute(['context','show']);
  check(typeof context==='string'&&context.trim()==='default',
    'remote or non-default Docker context not permitted');
  const endpoint=json(execute(['context','inspect','default','--format',
    '{{json .Endpoints.docker.Host}}']),'Docker local endpoint');
  check(endpoint==='unix:///var/run/docker.sock',
    'Docker endpoint must be the local Linux Unix socket');
}

function inspected(execute,ref){
  check(ID.test(ref||'')||/^sedeagro-(?:backend|frontend)-rc:[a-f0-9]{40}$/.test(ref||''),
    'only explicit immutable image ID or exact release tag may be inspected');
  const args=['--context','default','image','inspect','--format','{{json .}}',ref];
  return json(execute(args),'local Docker image metadata');
}

export function validateSignedHostImagePair({sha,receipt,context,execute}={}){
  check(SHA.test(sha||'')&&context?.release_sha===sha&&
    Array.isArray(receipt?.images)&&receipt.images.length===2&&
    receipt.head===sha&&context.image_ids&&
    SERVICES.every((service,i)=>{
      const im=receipt.images[i];
      return im?.service===service&&
        im.tag==='sedeagro-'+service+'-rc:'+sha&&
        ID.test(im.config_id||'')&&
        context.image_ids[service]===im.config_id;
    })&&receipt.images[0].config_id!==receipt.images[1].config_id,
  'seven signed subjects and two distinct image IDs required');
  check(typeof execute==='function','read-only Docker inspector required');
  validateLocalDockerContext(execute);
  // Image config IDs are immutable. Inspect by ID, then verify the expected
  // tag resolves to those same bytes, twice to detect retagging during review.
  // No assertion here can guarantee a FUTURE container-create operation.
  for(let pass=0;pass<2;pass++){
    for(const im of receipt.images){
      const fixed=inspected(execute,im.config_id);
      const tagged=inspected(execute,im.tag);
      validateImportedImage(fixed,im,sha);
      validateImportedImage(tagged,im,sha);
      check(fixed.Id===tagged.Id&&
        JSON.stringify(fixed.RootFS?.Layers)===
          JSON.stringify(tagged.RootFS?.Layers),
      'mutable tag no longer resolves to signed config and layers');
    }
  }
  return {
    status:STATUS,head:sha,
    oci_archive_sha256:context.oci_archive_sha256,
    oci_receipt_sha256:context.oci_receipt_sha256,
    security_receipt_sha256:context.security_receipt_sha256,
    inspected_image_ids:Object.fromEntries(receipt.images.map(im=>
      [im.service,im.config_id])),
    local_docker_context:'default',
    images_loaded_during_check:false,containers_created:false,
    image_pull_allowed:false,build_allowed:false,
    signed_security_inventory_verified:true,
    security_owner_approved:false,release_go:false,
    time_of_container_create_certified:false,
    staging_deploy_certified:false,production_deploy_certified:false
  };
}
export async function inspectHostSignedImages({
  sha,evidenceDir,
  verifyOci=verifySignedRelease,
  verifySecurity=verifySecuritySignatures,
  execute=command
}={}){
  check(SHA.test(sha||''),'exact lowercase main SHA40 required');
  const base=privateDir(evidenceDir);
  const ociDir=privateDir(join(base,'oci'));
  const securityDir=privateDir(join(base,'security'));
  const bundlePath=join(ociDir,'sedeagro-images-'+sha+'.tar');
  const receiptPath=join(ociDir,'sedeagro-images-'+sha+'.json');
  const bytes=readReceipt(receiptPath,sha);
  // Complete TAR+receipt signature, followed by all FIVE signed image
  // security subjects. Signed scan remains review-only: release_go=false.
  const oci=await verifyOci({sha,bundlePath,receiptPath});
  const security=await verifySecurity({sha,dir:securityDir,ociReceiptPath:receiptPath});
  const context=verifiedReleaseRiskContext({sha,oci,security,receiptBytes:bytes});
  const receipt=json(bytes.toString('utf8'),'verified OCI receipt');
  return validateSignedHostImagePair({sha,receipt,context,execute});
}
async function main(){
  const a=process.argv;
  check(a.length===6&&a[2]==='--sha'&&a[4]==='--evidence-dir',
    'only --sha SHA40 --evidence-dir PRIVATE_DIR allowed');
  const sha=a[3];
  check(SHA.test(sha||'')&&process.platform==='linux'&&
    !['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']
      .some(key=>process.env[key]),
  'local Linux operator with no Docker endpoint overrides required');
  const commandGit=args=>execFileSync('git',['-C',ROOT,...args],{
    encoding:'utf8',timeout:5000,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe']
  }).trim();
  check(commandGit(['symbolic-ref','--short','HEAD'])==='main'&&
    commandGit(['rev-parse','HEAD'])===sha&&
    commandGit(['rev-parse','refs/remotes/origin/main'])===sha&&
    commandGit(['status','--porcelain','--untracked-files=no'])==='',
  'clean exact-SHA local main and origin/main are mandatory');
  const result=await inspectHostSignedImages({sha,evidenceDir:a[5]});
  console.log(JSON.stringify(result));
  console.log('NOT AUTHORIZED: no image load/create, Security Owner GO, staging, migrations or production.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  main().catch(()=>{
    console.error('BLOCKED read-only host OCI inspection: missing signed evidence, local image identity, or safe host context');
    process.exitCode=2;
  });
}
