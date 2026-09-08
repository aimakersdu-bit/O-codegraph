import { Router } from 'express';
import * as fs from 'fs';
import { getDbRoot } from '../services/sqlite-locator';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      const root = getDbRoot();
      const exists = fs.existsSync(root);
      return res.json({
        status: 'ok',
        database: exists ? 'ready' : 'missing',
        root,
      });
    } catch (err: any) {
      return res.status(500).json({
        status: 'error',
        database: 'error',
        error: err.message || 'Database connection failed',
      });
    }
  });

  return router;
}
