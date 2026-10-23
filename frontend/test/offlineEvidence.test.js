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
const uploaded=(id,payload)=>({data:{
  id:'c1540167-5bcb-46f0-84ce-3e83245de72f',
  scouting_observation_id:id,
  uploaded_by:USER,
  client_upload_id:payload.client_upload_id,
  kind:payload.kind,
  mime_type:payload.mime_type,
  original_name:payload.original_name,
  size_bytes:12
}});

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

test('lost photo ACK preserves UUID and requires fresh personal receipt for photo-only replay',async()=>{
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
  let batches=0;
  const replay=await queue.flush(session,async body=>{batches++;return reply(body);},{
    force:true,sendEvidence:async(id,payload)=>{submissions++;return uploaded(id,payload);}
  });
  assert.equal(replay.attempted,0);
  assert.equal(replay.sent,0);
  assert.equal(replay.photoRecoveryRequired,1);
  assert.equal(batches,0);
  assert.equal(submissions,1);
  assert.equal(rows.size,1);
  assert.equal(rows.get(draft.id).evidence.client_upload_id,originalUploadId);
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

test('auto photo ACK must bind asset identity, user, MIME, name and exact size before deleting draft',async()=>{
  // A server 200 alone cannot prove that the photo persisted belongs to this
  // scout/observation. The test uses the real flush path, not a mock validator.
  const attacks=[
    ['missing asset UUID',out=>{delete out.data.id;}],
    ['invalid asset UUID',out=>{out.data.id='not-an-id';}],
    ['wrong uploader',out=>{out.data.uploaded_by=TENANT;}],
    ['missing uploader',out=>{delete out.data.uploaded_by;}],
    ['wrong kind',out=>{out.data.kind='document';}],
    ['wrong MIME',out=>{out.data.mime_type='image/jpeg';}],
    ['wrong original name',out=>{out.data.original_name='other.png';}],
    ['wrong byte count',out=>{out.data.size_bytes=1;}],
    ['noninteger byte count',out=>{out.data.size_bytes='12';}],
    ['wrong observation',out=>{out.data.scouting_observation_id=TENANT;}],
    ['wrong stable upload id',out=>{out.data.client_upload_id=OBS;}]
  ];
  for(const [label,mutate] of attacks){
    const {queue,rows}=harness();
    const draft=await queue.queueObservation(session,RUN,{...values,photo});
    const original=structuredClone(draft.evidence);
    const result=await queue.flush(session,async body=>reply(body),{
      sendEvidence:async(id,payload)=>{
        const out=uploaded(id,payload);
        mutate(out);
        return out;
      }
    });
    assert.equal(result.attempted,1,label);
    assert.equal(result.sent,0,label);
    assert.equal(rows.size,1,label);
    const [retained]=await queue.list(session);
    assert.equal(retained.state,'pending',label);
    assert.equal(retained.syncedObservationId,OBS,label);
    assert.equal(retained.attempts,1,label);
    assert.deepEqual(retained.evidence,original,label);
    assert.equal(retained.idempotencyKey,draft.idempotencyKey,label);
  }
});

test('bad photo receipt keeps bytes until explicit personal photo-only recovery',async()=>{
  const {queue,rows}=harness();
  const draft=await queue.queueObservation(session,RUN,{...values,photo});
  let seen=0;
  const sender=async(id,payload)=>{
    seen++;
    const out=uploaded(id,payload);
    if(seen===1)out.data.original_name='wrong-name.png';
    else out.replayed=true;
    return out;
  };
  const first=await queue.flush(session,async body=>reply(body),{sendEvidence:sender});
  assert.equal(first.sent,0);
  assert.equal(rows.size,1);
  const pending=(await queue.list(session))[0];
  assert.equal(pending.evidence.client_upload_id,draft.evidence.client_upload_id);
  assert.equal(pending.state,'pending');
  await queue.allowRetry(session,draft.id);
  let batches=0;
  const second=await queue.flush(session,async body=>{batches++;return reply(body);},{
    force:true,sendEvidence:sender
  });
  assert.equal(second.attempted,0);
  assert.equal(second.sent,0);
  assert.equal(second.photoRecoveryRequired,1);
  assert.equal(batches,0);
  assert.equal(rows.size,1);
  assert.equal(rows.get(draft.id).evidence.content_base64,IMAGE);
  assert.equal(seen,1);
});

test('global flush never resends an observation whose photo alone lacks ACK',async()=>{
  const {queue,rows}=harness();
  const draft=await queue.queueObservation(session,RUN,{...values,photo});
  const first=await queue.flush(session,async body=>reply(body),{
    sendEvidence:async()=>{throw new TypeError('photo ACK lost');}
  });
  assert.equal(first.sent,0);
  const waiting=structuredClone(rows.get(draft.id));
  assert.equal(waiting.syncedObservationId,OBS);
  assert.equal(waiting.state,'pending');
  let batches=0,uploads=0;
  const second=await queue.flush(session,async()=>{
    batches++; throw Error('must not replay an applied observation batch');
  },{
    force:true,sendEvidence:async()=>{uploads++;throw Error('requires fresh personal receipt');}
  });
  assert.equal(second.attempted,0);
  assert.equal(second.sent,0);
  assert.equal(second.photoRecoveryRequired,1);
  assert.equal(batches,0);
  assert.equal(uploads,0);
  assert.deepEqual(rows.get(draft.id),waiting);
});

test('global flush sends other new observations without replaying a photo-only draft',async()=>{
  const {queue,rows}=harness();
  const first=await queue.queueObservation(session,RUN,{...values,photo});
  await queue.flush(session,async body=>reply(body),{
    sendEvidence:async()=>{throw Object.assign(new Error('Photo gateway unavailable'),{status:503});}
  });
  const partial=structuredClone(rows.get(first.id));
  assert.equal(partial.syncedObservationId,OBS);
  const other=await queue.queueObservation(session,RUN,values);
  const batches=[];
  const summary=await queue.flush(session,async body=>{
    batches.push(body.idempotency_key);
    return reply(body);
  },{force:true,sendEvidence:async()=>{throw Error('photo must require receipt');}});
  assert.deepEqual(batches,[other.idempotencyKey]);
  assert.equal(summary.attempted,1);
  assert.equal(summary.sent,1);
  assert.equal(summary.photoRecoveryRequired,1);
  assert.deepEqual(rows.get(first.id),partial);
  assert.equal(rows.has(other.id),false);
});

test('freshly reread photo-only draft blocks a stale queue-list snapshot before network',async()=>{
  const saved=createPendingObservation({
    session,runId:RUN,values:{...values,photo},
    uuid:(()=>{let n=0;return()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;})(),
    now:new Date('2026-10-14T16:00:00Z')
  });
  const latest={...saved,syncedObservationId:OBS};
  const records=new Map([[saved.id,structuredClone(latest)]]);
  const queue=createOfflineQueue({
    store:{
      list:async()=>[structuredClone(saved)],
      get:async id=>structuredClone(records.get(id)),
      put:async()=>{throw Error('must not mutate recovery-only draft');},
      delete:async()=>{throw Error('must not delete recovery-only draft');}
    },isOnline:()=>true
  });
  let network=0;
  const result=await queue.flush(session,async()=>{network++;throw Error('must not post');},
    {force:true,sendEvidence:async()=>{network++;throw Error('must not upload');}});
  assert.equal(result.attempted,0);
  assert.equal(result.photoRecoveryRequired,1);
  assert.equal(network,0);
  assert.deepEqual(records.get(saved.id),latest);
});
