import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import * as mysql from 'mysql2/promise';
import { MysqlDatabaseImpl, runMigrations } from '@codegraph/shared';
import { authMiddleware } from './middleware/auth';
import { createIngestRouter } from './routes/ingest';
import { createVersionsRouter } from './routes/versions';
import { createHealthRouter } from './routes/health';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

const dbConfig = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'root',
  database: process.env.MYSQL_DATABASE || 'codegraph',
};

// Initialize connection pool synchronously
const db = new MysqlDatabaseImpl(dbConfig);

// Register routes synchronously
app.use('/api/v1', createHealthRouter(db));
app.use('/api/v1', authMiddleware);
app.use('/api/v1', createIngestRouter(db));
app.use('/api/v1', createVersionsRouter(db));

async function startServer() {
  console.log('[Server] Initializing database connection...');

  // 1. Run migrations on startup
  const migrationConn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
  });
  await migrationConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
  await migrationConn.query(`USE \`${dbConfig.database}\``);

  let migrationDir = path.resolve(__dirname, '../../shared/src/schema');
  if (!fs.existsSync(migrationDir)) {
    migrationDir = path.resolve(__dirname, '../../shared/dist/schema');
  }

  await runMigrations(migrationConn, migrationDir);
  await migrationConn.end();

  const server = app.listen(port, () => {
    console.log(`[Server] Ingestion service listening on port ${port}`);
  });

  const shutdown = async () => {
    console.log('[Server] Graceful shutdown initiated...');
    server.close(async () => {
      await db.close();
      console.log('[Server] Server closed. Exiting.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run server directly if executed as the entry point
if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Server] Startup failed:', err);
    process.exit(1);
  });
}

export { app, dbConfig, db };
