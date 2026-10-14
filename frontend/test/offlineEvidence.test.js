import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineQueue } from '../src/services/offlineQueue.js';
import { createPendingObservation } from '../src/services/offlineSyncModel.js';
import { MAX_OFFLINE_PHOTO_BYTES, validateOfflinePhoto } from '../src/services/offlinePhoto.js';
import { generateLocalKey, sealOfflineDraft, openOfflineDraft } from '../src/services/offlineDraftCrypto.js';
import { webcrypto } from 'node:crypto';

const TENANT='5ed977b4-6e20-4139-86eb-bcf0df252886';
const USER='4294c30d-6c4c-4c36-8fc1-597877bfecee';
const RUN='34b2f93a-21cf-4991-9cc3-adb40f79b7c0';
const OBS='f1978b40-05a4-4975-810d-3e4a5e7280a2';
const IMAGE=Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64');
const session={token:'test',tenant:{id:TENANT},user:{id:USER}};
const values={notes:'Private crop photo notes',observation_type:'pest',severity:'high'};
const photo={original_name:'field.png',mime_type:'image/png',content_base64:IMAGE};
const uuid=(()=>{let n=0;return ()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;})();
const reply=(body)=>({data:{status:'processed',idempotency_key:body.idempotency_key,
  operations:body.operations.map(op=>({entity_client_id:op.entity_client_id,status:'applied',
    result:{observation_id:OBS}}))}});
const uploaded=(id,payload)=>({data:{scouting_observation_id:id,
  client_upload_id:payload.client_upload_id,size_bytes:12,id:'c1540167-5bcb-46f0-84ce-3e83245de72f'}});

function harness() {
  const rows=new Map();
  const store={get:async id=>rows.get(id),put:async item=>rows.set(item.id,structuredClone(item)),
    delete:async id=>rows.delete(id),list:async scope=>[...rows.values()].filter(row=>row.scope===scope)};
  const queue=createOfflineQueue({store,uuid,now:()=>new Date('2026-10-14T16:00:00.000Z'),
    isOnline:()=>true});
  return {queue,rows};
}

test('offline photo types and 512KiB quota are validated before encrypting',()=>{
  assert.equal(validateOfflinePhoto(photo).size_bytes,12);
  assert.throws(()=>validateOfflinePhoto({...photo,mime_type:'image/svg+xml'}),/JPEG/i);
  assert.throws(()=>validateOfflinePhoto({...photo,original_name:'../a.png'}),/Nombre/i);
  assert.throws(()=>validateOfflinePhoto({...photo,content_base64:'bad$'}),/Contenido/i);
  assert.throws(()=>validateOfflinePhoto({...photo,content_base64:Buffer.alloc(MAX_OFFLINE_PHOTO_BYTES+1).toString('base64')}),/512 KiB/i);
});

test('photo bytes are inside encrypted draft, never inside /sync/batches request body', async()=>{
  const record=createPendingObservation({session,runId:RUN,values:{...values,photo},uuid,now:new Date()});
  assert.equal(record.body.operations[0].payload.notes,values.notes);
  assert.equal(record.body.operations[0].payload.content_base64,undefined);
  assert.equal(record.evidence.content_base64,IMAGE);
  assert.ok(record.evidence.client_upload_id);
  const key=await generateLocalKey(webcrypto);
  const sealed=await sealOfflineDraft(record,key,webcrypto);
  assert.ok(!JSON.stringify(sealed).includes(IMAGE));
  assert.ok(!JSON.stringify(sealed).includes(values.notes));
  assert.equal((await openOfflineDraft(sealed,key,webcrypto)).evidence.content_base64,IMAGE);
});

test('photo waits for observation receipt and deletes only after both acknowledgments',async()=>{
  const {queue,rows}=harness();
  await queue.queueObservation(session,RUN,{...values,photo});
  const calls=[];
  const result=await queue.flush(session,async body=>{calls.push('observation');return reply(body);},{
    sendEvidence:async (id,payload)=>{calls.push('photo');assert.equal(id,OBS);return uploaded(id,payload);}
  });
  assert.equal(result.sent,1);
  assert.deepEqual(calls,['observation','photo']);
  assert.equal(rows.size,0);
});

test('lost upload ACK preserves stable UUID and partial success for idempotent replay',async()=>{
  const {queue,rows}=harness();
  const draft=await queue.queueObservation(session,RUN,{...values,photo});
  const originalUploadId=draft.evidence.client_upload_id;
  let submissions=0;
  const first=await queue.flush(session,async body=>reply(body),{
    sendEvidence:async()=>{submissions++;throw Object.assign(new Error('Conexión perdida'),{status:0});}
  });
  assert.equal(first.sent,0);
  assert.equal(rows.size,1);
  const partial=(await queue.list(session))[0];
  assert.equal(partial.syncedObservationId,OBS);
  assert.equal(partial.evidence.client_upload_id,originalUploadId);
  await queue.allowRetry(session,draft.id);
  const replay=await queue.flush(session,async body=>reply(body),{
    force:true,sendEvidence:async(id,payload)=>{submissions++;assert.equal(payload.client_upload_id,originalUploadId);return uploaded(id,payload);}
  });
  assert.equal(replay.sent,1);
  assert.equal(submissions,2);
  assert.equal(rows.size,0);
});

test('photo conflict keeps applied observation visible without deleting original image',async()=>{
  const {queue}=harness();
  await queue.queueObservation(session,RUN,{...values,photo});
  const result=await queue.flush(session,async body=>reply(body),{
    sendEvidence:async()=>{throw Object.assign(new Error('Recorrida cerrada'),{status:409});}
  });
  assert.equal(result.conflicts,1);
  const [item]=await queue.list(session);
  assert.equal(item.state,'conflict');
  assert.equal(item.syncedObservationId,OBS);
  assert.equal(item.evidence.content_base64,IMAGE);
  assert.equal(item.attempts,1);
});

test('invalid photo receipt cannot discard the encrypted upload and the retry stays stable',async()=>{
  const {queue,rows}=harness();
  await queue.queueObservation(session,RUN,{...values,photo});
  await queue.flush(session,async body=>reply(body),{
    sendEvidence:async()=>({data:{id:'missing-observation-binding'}})
  });
  assert.equal(rows.size,1);
  const [item]=await queue.list(session);
  assert.equal(item.state,'pending');
  assert.ok(item.syncedObservationId);
});
