// The runtime non-owner may receive multiple explicit tenant identifiers.
// They must agree before tenant transaction/auth scope is established.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import pg from 'pg';

if(!process.env.TEST_DATABASE_ADMIN_URL||!process.env.TEST_DATABASE_APP_URL) {
  throw new Error('tenantHintConflict.pg.mjs requires disposable PostGIS TEST URLs');
}
process.env.DATABASE_URL=process.env.TEST_DATABASE_APP_URL;
process.env.NODE_ENV='test';
process.env.JWT_SECRET='routing-hints-disposable-postgis-only';

const {createApp}=await import('../src/app.js');
const {sequelize}=await import('../src/core/db.js');
const {hashPassword}=await import('../src/utils/password.js');
const {isSafeRuntimeDbRole}=await import('../src/core/tenantDbSafety.js');

test('tenant ID/slug/host mismatch fails closed even with valid bearer cookie or role',async t=>{
  const owner=new pg.Client({connectionString:process.env.TEST_DATABASE_ADMIN_URL});
  const app=new pg.Client({connectionString:process.env.TEST_DATABASE_APP_URL});
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await sequelize.close();
  });
  const base='http://127.0.0.1:'+server.address().port+'/api/v1';
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const password='TenantHintRejectSecure2026!';
  const tenants=[],users=[];
  let readyOwner=false,readyApp=false;
  const create=async(sql,params)=>(await owner.query(sql,params)).rows[0].id;
  // Node's fetch transport may ignore a caller-supplied Host and restore
  // URL authority. Use raw HTTP to prove the server receives the exact Host.
  async function callWithHost(host,headers) {
    return new Promise((resolve,reject)=>{
      const req=httpRequest({
        hostname:'127.0.0.1',port:server.address().port,
        path:'/api/v1/auth/me',method:'GET',
        headers:{...headers,Host:host}
      },res=>{
        const chunks=[];
        res.on('data',chunk=>chunks.push(chunk));
        res.on('error',reject);
        res.on('end',()=>{
          try {
            const raw=Buffer.concat(chunks).toString('utf8');
            resolve({status:res.statusCode,body:raw?JSON.parse(raw):null});
          } catch(error){reject(error);}
        });
      });
      req.on('error',reject);
      req.end();
    });
  }
  async function call(path,{method='GET',headers={},body}={}){
    const response=await fetch(base+path,{
      method,headers:{
        ...headers,...(body?{'content-type':'application/json'}:{})
      },...(body?{body:JSON.stringify(body)}:{})
    });
    const data=await response.text();
    return {status:response.status,body:data?JSON.parse(data):null};
  }
  try{
    await owner.connect();readyOwner=true;
    await app.connect();readyApp=true;
    const db=(await owner.query('SELECT current_database() AS db')).rows[0].db;
    assert.match(db,/(?:^|[_-])test(?:$|[_-])/i);
    const role=(await app.query(`
      SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
        pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname=current_database()
      WHERE r.rolname=current_user
    `)).rows[0];
    assert.ok(isSafeRuntimeDbRole(role));
    const plan=(await owner.query("SELECT id FROM plans WHERE code='starter'")).rows[0];
    assert.ok(plan);
    const slugs=['route-hint-a-'+suffix,'route-hint-b-'+suffix];
    for(const slug of slugs){
      tenants.push(await create(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'Routing hints '+slug,slug]));
    }
    const [a,b]=tenants;
    const email='route-hint-member-'+suffix+'@example.test';
    const userId=await create(
      'INSERT INTO users(email,full_name,password_hash) VALUES($1,$2,$3) RETURNING id',
      [email,'Routing Hint Member',await hashPassword(password)]);
    users.push(userId);
    await owner.query(
      "INSERT INTO memberships(tenant_id,user_id,role_code,status) VALUES($1,$2,'tenant_admin','active')",
      [b,userId]);
    const login=await call('/auth/login',{method:'POST',body:{email,password,tenantId:b}});
    assert.equal(login.status,200,JSON.stringify(login.body));
    const token=login.body.token;
    assert.ok(token);
    const auth={authorization:'Bearer '+token};
    const own={...auth,'x-tenant-id':b};
    const me=await call('/auth/me',{headers:own});
    assert.equal(me.status,200,JSON.stringify(me.body));

    // Correct redundant ID and slug are legitimate and must not break normal
    // clients that include both hints when they agree.
    const both=await call('/auth/me',{headers:{
      ...own,'x-tenant-slug':slugs[1]
    }});
    assert.equal(both.status,200,JSON.stringify(both.body));

    // Stale tenant ID alongside a correct foreign slug must not be ignored.
    const idMismatch=await call('/auth/me',{headers:{
      ...auth,'x-tenant-id':a,'x-tenant-slug':slugs[1]
    }});
    assert.equal(idMismatch.status,400,JSON.stringify(idMismatch.body));
    assert.equal(idMismatch.body.error.code,'TENANT_HINT_CONFLICT');
    assert.equal(idMismatch.body.user,undefined);

    const opposite=await call('/auth/me',{headers:{
      ...auth,'x-tenant-id':b,'x-tenant-slug':slugs[0]
    }});
    assert.equal(opposite.status,400,JSON.stringify(opposite.body));
    assert.equal(opposite.body.error.code,'TENANT_HINT_CONFLICT');

    const badId=await call('/auth/me',{headers:{
      ...auth,'x-tenant-id':'not-a-uuid'
    }});
    assert.equal(badId.status,400,JSON.stringify(badId.body));
    assert.equal(badId.body.error.code,'TENANT_ID_INVALID');

    // Even a valid tenant token must not override a contradicting Host and
    // explicit tenant slug. Rejection precedes setActorId/ALS tenancy.
    const hostConflict=await callWithHost(slugs[0]+'.example.test',{
      ...own,'x-tenant-slug':slugs[1]
    });
    assert.equal(hostConflict.status,400,JSON.stringify(hostConflict.body));
    assert.equal(hostConflict.body.error.code,'TENANT_HINT_CONFLICT');

    const foreign=await call('/auth/me',{headers:{
      ...auth,'x-tenant-id':a
    }});
    assert.equal(foreign.status,403,'JWT B cannot operate in valid tenant A');
    const stillGood=await call('/auth/me',{headers:own});
    assert.equal(stillGood.status,200,'a bad request must never poison later tenant routing');
  }finally{
    if(readyOwner){
      try{
        if(tenants.length)await owner.query(
          'DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
        if(users.length)await owner.query(
          'DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);
      }finally{await owner.end();}
    }
    if(readyApp)await app.end();
  }
});
