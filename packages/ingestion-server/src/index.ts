import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authMiddleware } from './middleware/auth';
import { createVersionsRouter } from './routes/versions';
import { createHealthRouter } from './routes/health';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Register routes synchronously
app.use('/api/v1', createHealthRouter());
app.use('/api/v1', authMiddleware);
app.use('/api/v1', createVersionsRouter());

async function startServer() {
  const server = app.listen(port, () => {
    console.log(`[Server] SQLite query service listening on port ${port}`);
  });

  const shutdown = async () => {
    console.log('[Server] Graceful shutdown initiated...');
    server.close(async () => {
      console.log('[Server] Server closed. Exiting.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Server] Startup failed:', err);
    process.exit(1);
  });
}

export { app };
