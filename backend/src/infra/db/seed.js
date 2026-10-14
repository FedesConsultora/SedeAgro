import { Umzug, SequelizeStorage } from 'umzug';
import { sequelize } from '../../core/db.js';
import '../../models/index.js';
import { demoSeedEnabled } from './seedPolicy.js';

const command = process.argv[2] || 'up';

const umzug = new Umzug({
  migrations: {
    // Only global catalogs are seeded by default; demo data is explicit opt-in.
    glob: demoSeedEnabled() ? 'db/seeders/*.js' : 'db/seeders/*_seed_global_*.js'
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
