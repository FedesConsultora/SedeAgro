import { fileURLToPath } from 'node:url';
import { sequelize } from '../../core/db.js';
import '../../models/index.js';
import { runTrackedMigrations } from './trackedMigrations.js';

const command = process.argv[2] || 'up';
try {
  const result = await runTrackedMigrations({
    sequelize,
    directory: fileURLToPath(new URL('../../../db/migrations/', import.meta.url)),
    tableName: 'sequelize_migrations',
    command
  });
  if (command === 'status') {
    console.table([
      ...result.executed.map(name => ({ name, status: 'executed' })),
      ...result.pending.map(name => ({ name, status: 'pending' }))
    ]);
  }
} finally {
  await sequelize.close();
}
