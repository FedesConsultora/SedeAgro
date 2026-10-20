import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTrackedMigrations, discoverTrackedScripts } from '../src/infra/db/trackedMigrations.js';

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sedeagro-migrations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  const scripts = join(dir, 'scripts');
  await mkdir(scripts);
  return { dir, scripts };
}
function stub(initial = []) {
  const state = new Set(initial);
  const calls = [];
  const storage = {
    sync: async () => { calls.push('sync'); },
    findAll: async () => [...state].map(name => ({ name })),
    create: async ({ name }) => { calls.push('log:' + name); state.add(name); },
    destroy: async ({ where: { name } }) => { calls.push('unlog:' + name); state.delete(name); }
  };
  const context = { steps: calls };
  const sequelize = { getQueryInterface: () => context };
  return { state, calls, context, storage, sequelize };
}
async function file(dir, name, body) {
  const defaultBody = "export async function up({context}) { context.steps.push('up:" + name +
    "') }\nexport async function down({context}) { context.steps.push('down:" + name + "') }\n";
  await writeFile(join(dir, name), body || defaultBody);
}

test('discovers only regular sorted .js files, not arbitrary extensions', async t => {
  const { scripts } = await sandbox(t);
  await file(scripts, '002_second.js'); await file(scripts, '001_first.js');
  await file(scripts, 'not-a-migration.txt');
  assert.deepEqual(await discoverTrackedScripts(scripts), ['001_first.js','002_second.js']);
  assert.equal((await readdir(scripts)).length,3);
});

test('up preserves Umzug v3 ledger names and only executes pending files once', async t => {
  const { scripts } = await sandbox(t);
  await file(scripts, '001_first.js'); await file(scripts, '002_second.js');
  const db = stub(['001_first.js']);
  const options={ ...db, directory:scripts, tableName:'sequelize_migrations',command:'up',logger:{} };
  const result = await runTrackedMigrations(options);
  assert.deepEqual([...db.state].sort(), ['001_first.js','002_second.js']);
  assert.deepEqual(result.executed,['001_first.js','002_second.js']);
  assert.deepEqual(db.calls,['sync','up:002_second.js','log:002_second.js']);
  db.calls.length = 0;
  await runTrackedMigrations(options);
  assert.deepEqual(db.calls,['sync']);
});

test('down rolls back last applied and status reports remaining history', async t => {
  const { scripts } = await sandbox(t);
  await file(scripts,'001_first.js'); await file(scripts,'002_second.js');
  const db=stub(['001_first.js','002_second.js']);
  await runTrackedMigrations({ ...db,directory:scripts,tableName:'sequelize_migrations',command:'down',logger:{} });
  assert.deepEqual(db.calls,['sync','down:002_second.js','unlog:002_second.js']);
  const status = await runTrackedMigrations({ ...db,directory:scripts,tableName:'sequelize_migrations',command:'status',logger:{} });
  assert.deepEqual(status,{executed:['001_first.js'],pending:['002_second.js']});
});

test('failed migration never logs success and missing historical code is blocking', async t => {
  const { scripts }=await sandbox(t);
  await file(scripts, '001_bad.js', "export async function up(){ throw Error('synthetic failure') }");
  const db=stub();
  await assert.rejects(runTrackedMigrations({...db,directory:scripts,tableName:'sequelize_migrations',logger:{}}),/synthetic failure/);
  assert.deepEqual([...db.state],[]);
  assert.ok(!db.calls.some(v=>v.startsWith('log:')));
  const historic=stub(['001_missing.js']);
  await assert.rejects(runTrackedMigrations({...historic,directory:scripts,tableName:'sequelize_migrations',command:'up',logger:{}}),/Applied migration missing/);
});

test('production seeder selection excludes demo but retains prior demo ledger', async t => {
  const { scripts }=await sandbox(t);
  await file(scripts,'001_seed_global_base.js');
  await file(scripts,'002_seed_demo_users.js');
  const db=stub(['002_seed_demo_users.js']);
  const include=name=>name.includes('_seed_global_');
  await runTrackedMigrations({ ...db, directory:scripts, tableName:'sequelize_seeders',
    include,command:'up',logger:{} });
  assert.deepEqual([...db.state].sort(),['001_seed_global_base.js','002_seed_demo_users.js']);
  assert.deepEqual(db.calls,['sync','up:001_seed_global_base.js','log:001_seed_global_base.js']);
  db.calls.length=0;
  await runTrackedMigrations({ ...db,directory:scripts,tableName:'sequelize_seeders',
    include,command:'down',logger:{} });
  assert.deepEqual(db.calls,['sync','down:001_seed_global_base.js','unlog:001_seed_global_base.js']);
});

test('unknown commands, storage and missing historically applied files fail closed', async t => {
  const { scripts }=await sandbox(t);
  await file(scripts,'001_first.js');
  const db=stub();
  for (const options of [{command:'reset'},{tableName:'users'},{directory:''}]) {
    await assert.rejects(runTrackedMigrations({
      ...db,directory:scripts,tableName:'sequelize_migrations',command:'up',...options,logger:{}
    }),/Invalid migration/);
  }
  const broken=stub(['001_first.js','002_missing.js']);
  await assert.rejects(runTrackedMigrations({...broken,directory:scripts,tableName:'sequelize_migrations',command:'status'}),/missing from checkout/);
});
