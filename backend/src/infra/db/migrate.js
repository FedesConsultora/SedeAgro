import { Umzug, SequelizeStorage } from 'umzug';
import { sequelize } from '../../core/db.js';
import '../../models/index.js';

const command = process.argv[2] || 'up';

const umzug = new Umzug({
  migrations: {
    glob: 'db/migrations/*.js'
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_migrations' }),
  logger: console
});

if (command === 'up') {
  await umzug.up();
} else if (command === 'down') {
  await umzug.down();
} else if (command === 'status') {
  const [executed, pending] = await Promise.all([umzug.executed(), umzug.pending()]);
  console.table([
    ...executed.map((migration) => ({ name: migration.name, status: 'executed' })),
    ...pending.map((migration) => ({ name: migration.name, status: 'pending' }))
  ]);
} else {
  throw new Error(`Unknown migration command: ${command}`);
}

await sequelize.close();
