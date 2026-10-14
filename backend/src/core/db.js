import { Sequelize, Op } from 'sequelize';
import { env } from '../config/env.js';
import { getTenantId } from './tenantContext.js';
import { logger } from './logger.js';
import { assertTenantTransaction, isSafeRuntimeDbRole, SET_TENANT_SQL } from './tenantDbSafety.js';

export const sequelize = new Sequelize(env.databaseUrl, {
  dialect: 'postgres',
  logging: env.logSql
    ? (message, timingMs) => logger.debug('db.query', {
      summary: String(message).replace(/\s+/g, ' ').slice(0, 220),
      duration_ms: timingMs
    })
    : false,
  benchmark: env.logSql,
  define: {
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  },
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

function isTenantScoped(model) {
  return Boolean(model?.rawAttributes?.tenant_id);
}

function mergeTenantWhere(where, tenantId) {
  if (!where || Object.keys(where).length === 0) return { tenant_id: tenantId };
  return { [Op.and]: [{ tenant_id: tenantId }, where] };
}

export function installTenantHooks() {
  // Sequelize validates required columns before beforeCreate. Without this hook,
  // tenant-scoped POSTs fail "tenant_id cannot be null" before insertion.
  sequelize.addHook('beforeValidate', (instance, options) => {
    const tenantId = getTenantId();
    if (!tenantId || options.skipTenantScope || !isTenantScoped(instance.constructor)) return;
    instance.set('tenant_id', tenantId);
  });

  sequelize.addHook('beforeFind', (options) => {
    const tenantId = getTenantId();
    if (!tenantId || options.skipTenantScope || !isTenantScoped(options.model)) return;
    options.where = mergeTenantWhere(options.where, tenantId);
  });

  sequelize.addHook('beforeCount', (options) => {
    const tenantId = getTenantId();
    if (!tenantId || options.skipTenantScope || !isTenantScoped(options.model)) return;
    options.where = mergeTenantWhere(options.where, tenantId);
  });

  sequelize.addHook('beforeCreate', (instance, options) => {
    const tenantId = getTenantId();
    if (!tenantId || options.skipTenantScope || !isTenantScoped(instance.constructor)) return;
    instance.set('tenant_id', tenantId);
  });

  sequelize.addHook('beforeBulkCreate', (instances, options) => {
    const tenantId = getTenantId();
    if (!tenantId || options.skipTenantScope || !instances.length || !isTenantScoped(instances[0].constructor)) return;
    for (const instance of instances) instance.set('tenant_id', tenantId);
  });

  sequelize.addHook('beforeUpdate', (instance, options) => {
    const tenantId = getTenantId();
    if (!tenantId || options.skipTenantScope || !isTenantScoped(instance.constructor)) return;
    instance.set('tenant_id', tenantId);
  });
}

export async function connectDb() {
  await sequelize.authenticate();
  // Superusers and BYPASSRLS roles silently ignore tenant policies, even with FORCE RLS.
  if (env.isProd) {
    const [[role]] = await sequelize.query(`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
             pg_get_userbyid(d.datdba) AS db_owner
      FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
      WHERE r.rolname = current_user
    `);
    if (!isSafeRuntimeDbRole(role)) {
      throw new Error('Unsafe PostgreSQL runtime role: require a non-owner without SUPERUSER, BYPASSRLS, CREATEDB or CREATEROLE.');
    }
  }
}

export async function setLocalTenant(transaction, tenantId = getTenantId()) {
  assertTenantTransaction(transaction, tenantId);
  await sequelize.query(SET_TENANT_SQL, {
    transaction,
    replacements: { tenantId }
  });
}

export async function withTenantTransaction(callback, tenantId = getTenantId()) {
  return sequelize.transaction(async (transaction) => {
    await setLocalTenant(transaction, tenantId);
    return callback(transaction);
  });
}
