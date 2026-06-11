import { Router } from 'express';
import { MysqlDatabase } from '@codegraph/shared';

export function createHealthRouter(db: MysqlDatabase): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      // Run a simple query to verify database connection
      await db.query('SELECT 1');
      return res.json({
        status: 'ok',
        database: 'connected',
      });
    } catch (err: any) {
      return res.status(500).json({
        status: 'error',
        database: 'disconnected',
        error: err.message || 'Database connection failed',
      });
    }
  });

  return router;
}
