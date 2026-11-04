// Pilot onboarding: REAL HTTP + disposable non-owner PostGIS acceptance of
// manual invitation rotation. Kept separate from the historical invitation
// suite so public IP rate limiting is never weakened by its adversarial load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Rotation acceptance requires disposable *_test DB URLs');
process.env.DATABASE_URL = appUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'member-rotation-disposable-test-only';
const { createApp } = await import('../src/app.js');
const { sequelize } = await import('../src/core/db.js');
const { signSession } = await import('../src/utils/jwt.js');
const { isSafeRuntimeDbRole } = await import('../src/core/tenantDbSafety.js');

test('lost manual invitation code rotates atomically, invalidates old token and accepts only a new one', async t => {
  const owner = new pg.Client({ connectionString: adminUrl });
  const runtime = new pg.Client({ connectionString: appUrl });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await sequelize.close();
  });
  const origin = 'http://127.0.0.1:' + server.address().port + '/api/v1/auth';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenants = [], users = [];
  let ownerReady = false, runtimeReady = false;
  const insert = async (sql, params) => (await owner.query(sql, params)).rows[0].id;
  const api = async (path, {method='GET',actor=null,tenant=null,body}={}) => {
    const result = await fetch(origin + path, {
      method,
      headers: {
        ...(actor ? { authorization:'Bearer ' + actor.token } : {}),
        ...(tenant ? { 'x-tenant-id':tenant } : {}),
        ...(body === undefined ? {} : { 'content-type':'application/json' })
      },
      ...(body === undefined ? {} : { body:JSON.stringify(body) })
    });
    const raw = await result.text();
    return {status:result.status, data:raw ? JSON.parse(raw) : null};
  };
  try {
    await owner.connect(); ownerReady = true;
    await runtime.connect(); runtimeReady = true;
    const name = (await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(name,/(?:^|[_-])test(?:$|[_-])/i);
    const policy = (await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid='public.member_invitations'::regclass
    `)).rows[0];
    assert.equal(policy.relrowsecurity,true);
    assert.equal(policy.relforcerowsecurity,true);
    const role = (await runtime.query(`
      SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows[0];
    assert.ok(isSafeRuntimeDbRole(role));
    const plan = (await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    async function tenant(tag) {
      const id = await insert(`
        INSERT INTO tenants(name,slug,plan_id,status)
        VALUES($1,$2,$3,'active') RETURNING id
      `, ['Rotation ' + tag, 'rotation-' + tag + '-' + suffix, plan.id]);
      tenants.push(id);
      return id;
    }
    const a=await tenant('a'), b=await tenant('b');
    async function actor(tenantId,label,roleCode) {
      const id=await insert(`
        INSERT INTO users(full_name,email,password_hash)
        VALUES($1,$2,'fixture') RETURNING id
      `,[label, 'rotation-' + suffix + '-' + label.replaceAll(' ','-') + '@example.test']);
      users.push(id);
      await owner.query(`
        INSERT INTO memberships(tenant_id,user_id,role_code,status)
        VALUES($1,$2,$3,'active')
      `,[tenantId,id,roleCode]);
      return {id,token:signSession({sub:id,tenant_id:tenantId,role_code:roleCode})};
    }
    const adminA=await actor(a,'Admin A','tenant_admin');
    const adminB=await actor(b,'Admin B','tenant_admin');
    const scoutA=await actor(a,'Scout A','scout');
    const email='recipient-' + suffix + '@example.test';
    const invite=async(mail,roleCode='scout') => api('/invitations',{
      method:'POST',actor:adminA,tenant:a,body:{email:mail,roleCode}
    });
    const rotate=(actor,tenant,id,revision)=>api('/invitations/'+id+'/rotate',{
      method:'POST',actor,tenant,body:{expectedUpdatedAt:revision}
    });
    const accept=token=>api('/invite/accept',{method:'POST',body:{
      token,password:'StrongTesting903',fullName:'New Rotation Scout'
    }});

    const initial=await invite(email);
    assert.equal(initial.status,201,JSON.stringify(initial.data));
    const id=initial.data.data.id;
    const originalToken=initial.data.delivery.token;
    const oldRevision=initial.data.data.updatedAt;
    assert.ok(Number.isFinite(Date.parse(oldRevision)));
    assert.equal((await rotate(scoutA,a,id,oldRevision)).status,403);
    assert.equal((await rotate(adminB,b,id,oldRevision)).status,404);
    const rotated=await rotate(adminA,a,id,oldRevision);
    assert.equal(rotated.status,200,JSON.stringify(rotated.data));
    assert.equal(rotated.data.data.id,id);
    assert.equal(rotated.data.data.email,email);
    assert.equal(rotated.data.data.roleCode,'scout');
    assert.equal(rotated.data.delivery.channel,'manual');
    assert.equal(rotated.data.delivery.delivered,false);
    assert.ok(Date.parse(rotated.data.data.updatedAt)>Date.parse(oldRevision));
    const firstReplacement=rotated.data.delivery.token;
    assert.notEqual(firstReplacement,originalToken);
    assert.equal((await accept(originalToken)).status,404);

    // Current revision must match the DB; losing the first ACK cannot permit
    // silent retry using a stale tab's row snapshot.
    const stale=await rotate(adminA,a,id,oldRevision);
    assert.equal(stale.status,409,JSON.stringify(stale.data));
    assert.equal(stale.data.error.code,'INVITATION_ROTATION_STALE');
    const listed=await api('/invitations',{actor:adminA,tenant:a});
    const row=listed.data.data.find(item=>item.id===id);
    assert.equal(row.updatedAt,rotated.data.data.updatedAt);
    assert.equal(JSON.stringify(listed.data).includes(originalToken),false);
    assert.equal(JSON.stringify(listed.data).includes(firstReplacement),false);

    const races=await Promise.all([
      rotate(adminA,a,id,row.updatedAt),
      rotate(adminA,a,id,row.updatedAt)
    ]);
    assert.deepEqual(races.map(result=>result.status).sort(),[200,409],
      JSON.stringify(races.map(result=>({status:result.status,code:result.data?.error?.code}))));
    const winner=races.find(result=>result.status===200);
    const acceptedToken=winner.data.delivery.token;
    assert.notEqual(acceptedToken,firstReplacement);
    assert.equal((await accept(firstReplacement)).status,404);
    const finalRow=(await owner.query(`
      SELECT token_hash,email,role_code,status,updated_at FROM member_invitations WHERE id=$1
    `,[id])).rows[0];
    assert.equal(finalRow.token_hash,
      createHash('sha256').update(acceptedToken,'utf8').digest('hex'));
    assert.equal(finalRow.role_code,'scout');
    assert.equal(finalRow.email,email);
    assert.equal(finalRow.status,'pending');
    assert.ok(new Date(finalRow.updated_at).getTime()>Date.parse(row.updatedAt));
    assert.equal((await owner.query(`
      SELECT count(*)::int AS n FROM member_invitations
      WHERE tenant_id=$1 AND email=$2 AND status='pending'
    `,[a,email])).rows[0].n,1);

    // Prove the new token activates the intended scout, once; the old hashes
    // cannot create memberships. The acceptance is REAL, not route.fulfill().
    const activated=await accept(acceptedToken);
    assert.equal(activated.status,201,JSON.stringify(activated.data));
    assert.equal(activated.data.data.tenant.id,a);
    assert.equal(activated.data.data.roleCode,'scout');
    const userId=(await owner.query(
      'SELECT id FROM users WHERE email=$1',[email])).rows[0].id;
    users.push(userId);
    assert.equal((await owner.query(`
      SELECT count(*)::int AS n FROM memberships
      WHERE tenant_id=$1 AND user_id=$2 AND status='active'
    `,[a,userId])).rows[0].n,1);
    const oldAccepted=await rotate(adminA,a,id,winner.data.data.updatedAt);
    assert.equal(oldAccepted.status,410);

    const revokedMail='revoke-' + suffix + '@example.test';
    const revoked=await invite(revokedMail,'contractor');
    assert.equal(revoked.status,201);
    assert.equal((await api('/invitations/'+revoked.data.data.id,{
      method:'DELETE',actor:adminA,tenant:a
    })).status,204);
    assert.equal((await rotate(adminA,a,revoked.data.data.id,
      revoked.data.data.updatedAt)).status,410);

    const expiredMail='expired-rotation-' + suffix + '@example.test';
    const expired=await invite(expiredMail);
    assert.equal(expired.status,201);
    await owner.query(`
      UPDATE member_invitations SET expires_at=now()-interval '1 second'
      WHERE id=$1
    `,[expired.data.data.id]);
    assert.equal((await rotate(adminA,a,expired.data.data.id,
      expired.data.data.updatedAt)).status,410);

    const audit=(await owner.query(`
      SELECT action,before,after FROM audit_events WHERE entity_id=$1 ORDER BY created_at
    `,[id])).rows;
    assert.deepEqual(audit.map(item=>item.action),[
      'member_invitation.created','member_invitation.rotated',
      'member_invitation.rotated','member_invitation.accepted'
    ]);
    const auditJson=JSON.stringify(audit);
    assert.equal(auditJson.includes(originalToken),false);
    assert.equal(auditJson.includes(firstReplacement),false);
    assert.equal(auditJson.includes(acceptedToken),false);
    await runtime.query('BEGIN');
    try {
      await runtime.query("SELECT set_config('app.current_tenant',$1,true)",[b]);
      const foreign=await runtime.query('SELECT id FROM member_invitations WHERE id=$1',[id]);
      assert.deepEqual(foreign.rows,[]);
    } finally { await runtime.query('ROLLBACK'); }
    assert.equal((await api('/invitations',{actor:adminB,tenant:b}))
      .data.data.some(item=>item.id===id),false);
  } finally {
    if (ownerReady) {
      try {
        if (tenants.length) await owner.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if (users.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      } finally { await owner.end(); }
    }
    if (runtimeReady) await runtime.end();
  }
});
