import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Sequelize, DataTypes, Utils } from 'sequelize';

const require = createRequire(import.meta.url);
const sequelizeRequire = createRequire(require.resolve('sequelize'));
const patched = sequelizeRequire('uuid');

test('Sequelize CommonJS resolver loads pinned patched uuid 11.1.1, not ESM-only uuid 12+', () => {
  const manifest = sequelizeRequire('uuid/package.json');
  assert.equal(manifest.version, '11.1.1');
  assert.equal(typeof patched.v1, 'function');
  assert.equal(typeof patched.v4, 'function');
  assert.equal(typeof patched.v5, 'function');
  assert.equal(typeof patched.v6, 'function');
  assert.equal(typeof sequelizeRequire('sequelize').Sequelize, 'function');
  assert.equal(require('sequelize/package.json').version, '6.37.8');
});

test('Sequelize UUIDV4 default generates canonical UUIDs with CJS patched uuid', () => {
  const generator = Utils.toDefaultValue(DataTypes.UUIDV4);
  assert.equal(typeof generator, 'string');
  assert.match(generator, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const orm = new Sequelize('postgres://unused:unused@localhost:5432/unused_test', { dialect:'postgres', logging:false });
  try {
    const Model = orm.define('UuidCompatOnly', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      label: { type: DataTypes.STRING, allowNull:false }
    }, { timestamps:false });
    const first = Model.build({ label:'a' });
    const second = Model.build({ label:'b' });
    assert.match(first.get('id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first.get('id'), second.get('id'));
  } finally {
    await orm.close();
  }
});

test('upstream patched v3/v5/v6 reject too-short supplied output buffer', () => {
  const tiny = new Uint8Array(1);
  for (const method of ['v3', 'v5']) {
    assert.throws(() => patched[method]('ci-field', patched[method].DNS, tiny), RangeError, method);
  }
  assert.throws(() => patched.v6({ random: new Uint8Array(16) }, tiny), RangeError);
});
