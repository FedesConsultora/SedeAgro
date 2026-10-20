// Narrow compatibility runner for Umzug v3 SequelizeStorage tables.
// Imports only repository-tracked migration modules. Deliberately preserves
// legacy run-one down semantics and non-transactional migration/ledger order.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DataTypes } from 'sequelize';

const TABLES = new Set(['sequelize_migrations', 'sequelize_seeders']);
const COMMANDS = new Set(['up', 'down', 'status']);
const NAME = /^[a-zA-Z0-9_-]+\.js$/;

export async function discoverTrackedScripts(directory, include = () => true) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(item => item.isFile() && NAME.test(item.name) &&
    include(item.name)).map(item => item.name).sort();
  if (new Set(files).size !== files.length) {
    throw new Error('Duplicate migration filenames');
  }
  return files;
}

function trackedStorage(sequelize, tableName) {
  // SequelizeStorage in Umzug 3 used (name STRING, primary key) and an
  // automatically created Sequelize model with timestamps disabled.
  const modelName = tableName === 'sequelize_migrations'
    ? 'SedeAgroMigrationLedger' : 'SedeAgroSeederLedger';
  return sequelize.define(modelName, {
    name: { type: DataTypes.STRING, allowNull: false, primaryKey: true, unique: true }
  }, { tableName, freezeTableName: true, timestamps: false });
}

export async function runTrackedMigrations({
  sequelize, directory, tableName, command = 'up',
  include = () => true, logger = console, storage
}) {
  if (!TABLES.has(tableName) || !COMMANDS.has(command) ||
      !sequelize || typeof sequelize.getQueryInterface !== 'function' ||
      typeof directory !== 'string' || directory.length === 0) {
    throw new Error('Invalid migration command, storage or directory');
  }
  const files = await discoverTrackedScripts(directory, include);
  const ledger = storage || trackedStorage(sequelize, tableName);
  await ledger.sync();
  const executedRows = await ledger.findAll({ attributes: ['name'], raw: true });
  const previously = new Set();
  for (const row of executedRows) {
    if (!row || typeof row.name !== 'string' || previously.has(row.name)) {
      throw new Error('Invalid or duplicated legacy migration ledger entry');
    }
    previously.add(row.name);
  }
  const available = new Set(files);
  if (tableName === 'sequelize_migrations') {
    for (const name of previously) {
      if (!available.has(name)) {
        throw new Error('Applied migration missing from checkout: ' + name);
      }
    }
  }
  const executed = files.filter(name => previously.has(name));
  const pending = files.filter(name => !previously.has(name));
  if (command === 'status') return { executed, pending };

  async function apply(name, direction) {
    const script = await import(pathToFileURL(join(directory, name)).href);
    if (typeof script[direction] !== 'function') {
      throw new Error('Migration lacks required ' + direction + '(): ' + name);
    }
    await script[direction]({ name, path: join(directory, name),
      context: sequelize.getQueryInterface() });
    if (direction === 'up') await ledger.create({ name });
    else await ledger.destroy({ where: { name } });
    logger.info?.(direction + ': ' + name);
  }
  if (command === 'up') {
    for (const name of pending) await apply(name, 'up');
  } else {
    // Umzug .down() without arguments reverts exactly the last applied file.
    // A seeded demo marker may exist although production excludes that file.
    const name = executed.at(-1);
    if (name) await apply(name, 'down');
  }
  return { executed: command === 'up' ? [...executed, ...pending] :
    executed.filter(name => name !== executed.at(-1)), pending };
}
