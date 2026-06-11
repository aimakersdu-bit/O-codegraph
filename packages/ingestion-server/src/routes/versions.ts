import { Router } from 'express';
import { MysqlDatabase, QueryBuilder } from '@codegraph/shared';
import { VersionCleaner } from '../services/cleaner';

export function createVersionsRouter(db: MysqlDatabase): Router {
  const router = Router();
  const cleaner = new VersionCleaner(db);

  // GET /api/v1/versions
  router.get('/versions', async (req, res) => {
    try {
      const { repo, branch } = req.query;
      if (!repo || !branch) {
        const rows = await db.query(
          'SELECT repo, branch, version_id, status, created_at FROM version_history WHERE status != ? ORDER BY created_at DESC',
          ['deleting']
        );
        return res.json(
          rows.map((row) => ({
            repo: row.repo,
            branch: row.branch,
            versionId: row.version_id,
            status: row.status,
            createdAt: Number(row.created_at),
          }))
        );
      }

      const qb = new QueryBuilder(db, {
        repo: String(repo),
        branch: String(branch),
        versionId: '',
      });
      const list = await qb.listVersions();
      return res.json(list);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // GET /api/v1/versions/:versionId/stats
  router.get('/versions/:versionId/stats', async (req, res) => {
    try {
      const { versionId } = req.params;
      const { repo, branch } = req.query;
      if (!repo || !branch) {
        return res.status(400).json({ error: 'Missing query parameters: repo, branch' });
      }

      const qb = new QueryBuilder(db, {
        repo: String(repo),
        branch: String(branch),
        versionId: String(versionId),
      });

      const stats = await qb.getStats();
      return res.json(stats);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // DELETE /api/v1/versions/:versionId
  router.delete('/versions/:versionId', async (req, res) => {
    try {
      const { versionId } = req.params;
      const { repo, branch } = req.query;
      if (!repo || !branch) {
        return res.status(400).json({ error: 'Missing query parameters: repo, branch' });
      }

      await cleaner.deleteSpecificVersion(String(repo), String(branch), String(versionId));
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return router;
}
