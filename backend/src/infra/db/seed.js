import { fileURLToPath } from 'node:url';
import { sequelize } from '../../core/db.js';
import '../../models/index.js';
import { demoSeedEnabled } from './seedPolicy.js';
import { runTrackedMigrations } from './trackedMigrations.js';

const command = process.argv[2] || 'up';
try {
  await runTrackedMigrations({
    sequelize,
    directory: fileURLToPath(new URL('../../../db/seeders/', import.meta.url)),
    tableName: 'sequelize_seeders',
    command,
    include: demoSeedEnabled() ? () => true : name => name.includes('_seed_global_')
  });
} finally {
  await sequelize.close();
}
