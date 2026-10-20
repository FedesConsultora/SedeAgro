// Real PostGIS acceptance. Only disposable *_test DB URLs on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Sequelize, DataTypes } from 'sequelize';
import { isSafeRuntimeDbRole } from '../src/core/tenantDbSafety.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_APP_URL;
for (const raw of [adminUrl, appUrl]) {
  if (!raw) throw new Error('Two disposable test DB URLs required');
  const url = new URL(raw);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) ||
      !/(?:^|[_-])test(?:$|[_-])/i.test(url.pathname.slice(1))) {
    throw new Error('BLOCKED: sequelize UUID integration only accepts loopback *_test databases');
  }
}

test('Sequelize uuid@11.1.1 CRUD and FORCE RLS isolate a generated v4 PK', async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  const app = new Sequelize(appUrl, { dialect:'postgres', logging:false, pool:{max:2,min:0,idle:1000} });
  const name = randomUUID().slice(0,8);
  const tenants = [];
  let adminConnected = false;
  let txn;
  try {
    await admin.connect(); adminConnected = true;
    const adminDb = (await admin.query('SELECT current_database() AS db')).rows[0].db;
    const appDb = (await app.query('SELECT current_database() AS db', { type: Sequelize.QueryTypes.SELECT }))[0].db;
    assert.equal(adminDb,appDb,'Both roles must access same isolated DB');
    const {rows:[plan]} = await admin.query("SELECT id FROM plans WHERE code='starter'");
    assert.ok(plan,'Migrations and global seed required');
    for (const label of ['a','b']) {
      const {rows:[t]} = await admin.query(
        "INSERT INTO tenants(plan_id,name,slug,status) VALUES($1,$2,$3,'active') RETURNING id",
        [plan.id,'UUID compatibility '+label,'uuid-ci-'+name+'-'+label]);
      tenants.push(t.id);
    }
    const [role] = await app.query([
      'SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,',
      'pg_get_userbyid(d.datdba) AS db_owner FROM pg_roles r',
      'JOIN pg_database d ON d.datname=current_database()',
      'WHERE r.rolname=current_user'
    ].join(' '),{type: Sequelize.QueryTypes.SELECT});
    assert.ok(isSafeRuntimeDbRole(role),'App role cannot own DB or bypass FORCE RLS');
    const Farm = app.define('UuidCompatFarm', {
      id: { type:DataTypes.UUID,defaultValue:DataTypes.UUIDV4,primaryKey:true },
      tenant_id: { type:DataTypes.UUID,allowNull:false },
      name: { type:DataTypes.STRING,allowNull:false }
    },{tableName:'farms',freezeTableName:true,timestamps:false});
    txn = await app.transaction();
    await app.query("SELECT set_config('app.current_tenant',:tenantId,true)",{
      transaction:txn,replacements:{tenantId:tenants[0]}
    });
    const created = await Farm.create({tenant_id:tenants[0],name:'Synthetic UUID farm'}, {transaction:txn});
    const id = created.get('id');
    assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const found = await Farm.findOne({where:{id},transaction:txn});
    assert.equal(found.get('id'),id);
    await found.update({name:'Synthetic UUID updated'},{transaction:txn});
    assert.equal((await Farm.findOne({where:{id},transaction:txn})).get('name'),'Synthetic UUID updated');

    // Switch tenant within same transaction; DB FORCE RLS, not ORM WHERE.
    await app.query("SELECT set_config('app.current_tenant',:tenantId,true)",{
      transaction:txn,replacements:{tenantId:tenants[1]}
    });
    assert.equal(await Farm.count({where:{id},transaction:txn}),0,
      'FORCE RLS must hide tenant-A generated UUID row from tenant B');
    await app.query("SELECT set_config('app.current_tenant',:tenantId,true)",{
      transaction:txn,replacements:{tenantId:tenants[0]}
    });
    assert.equal(await Farm.destroy({where:{id},transaction:txn}),1);
    assert.equal(await Farm.count({where:{id},transaction:txn}),0);
  } finally {
    if (txn && !txn.finished) await txn.rollback();
    await app.close().catch(() => {});
    if (adminConnected) {
      if (tenants.length) {
        await admin.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
      }
      await admin.end().catch(() => {});
    }
  }
});
