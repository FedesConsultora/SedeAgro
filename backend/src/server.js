import { env } from './config/env.js';
import { connectDb } from './core/db.js';
import { logger } from './core/logger.js';
import './models/index.js';
import { createApp } from './app.js';

await connectDb();

const app = createApp();
const server = app.listen(env.port, () => {
  logger.info('SedeAgro backend listening', { port: env.port });
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
