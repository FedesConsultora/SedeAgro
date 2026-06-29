import { Umzug, SequelizeStorage } from 'umzug';
import { sequelize } from '../../core/db.js';
import '../../models/index.js';

const command = process.argv[2] || 'up';

const umzug = new Umzug({
  migrations: {
    glob: 'db/seeders/*.js'
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_seeders' }),
  logger: console
});

if (command === 'up') {
  await umzug.up();
} else if (command === 'down') {
  await umzug.down();
} else {
  throw new Error(`Unknown seeder command: ${command}`);
}

await sequelize.close();
