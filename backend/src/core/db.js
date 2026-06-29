import { Sequelize, Op } from 'sequelize';
import { env } from '../config/env.js';
import { getTenantId } from './tenantContext.js';
import { logger } from './logger.js';

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
}

export async function setLocalTenant(transaction, tenantId = getTenantId()) {
  if (!tenantId) return;
  await sequelize.query('SET LOCAL app.current_tenant = :tenantId', {
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
