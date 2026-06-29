import dotenv from 'dotenv';

dotenv.config();

const requiredInProd = ['DATABASE_URL', 'JWT_SECRET'];

for (const key of requiredInProd) {
  if (process.env.NODE_ENV === 'production' && !process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),
  databaseUrl: process.env.DATABASE_URL || 'postgres://sedeagro:sedeagro_dev_password@localhost:5432/sedeagro',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  corsOrigin: process.env.CORS_ORIGIN || '',
  baseDomain: process.env.BASE_DOMAIN || '',
  fallbackTenantId: process.env.FALLBACK_TENANT_ID || '',
  seedMode: process.env.SEED_MODE || 'dev',
  logLevel: process.env.LOG_LEVEL || '',
  logSql: process.env.LOG_SQL === '1',
  logStack: process.env.LOG_STACK === '1' && process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production'
};
