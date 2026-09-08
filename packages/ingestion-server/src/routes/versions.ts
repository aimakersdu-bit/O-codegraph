import { Router } from 'express';
import * as fs from 'fs';
import { SqliteDatabaseImpl } from '@codegraph/shared';
import { getDbRoot, listDbFiles, resolveDbPath } from '../services/sqlite-locator';
import { openQueryBuilder } from '../services/sqlite-query';

export function createVersionsRouter(): Router {
  const router = Router();

  // GET /api/v1/versions
  router.get('/versions', async (req, res) => {
    try {
      const { repo, version } = req.query;
      if (!repo || !version) {
        const rows: Array<{ repo: string; version: string; versionId: string; status: string; createdAt: number }> = [];
        for (const file of listDbFiles(getDbRoot())) {
          const db = new SqliteDatabaseImpl(file);
          try {
            const metaRows = await db.query(
              'SELECT repo, version, version_id, status, created_at FROM version_history ORDER BY created_at DESC LIMIT 1'
            );
            const row = metaRows[0];
            if (row) {
              rows.push({
                repo: row.repo,
                version: row.version,
                versionId: row.version_id,
                status: row.status,
                createdAt: Number(row.created_at),
              });
            }
          } finally {
            await db.close();
          }
        }
        rows.sort((a, b) => b.createdAt - a.createdAt);
        return res.json(rows);
      }

      const { db, qb } = await openQueryBuilder(String(repo), String(version));
      try {
        const list = await qb.listVersions();
        return res.json(list);
      } finally {
        await db.close();
      }
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // GET /api/v1/versions/:versionId/stats
  router.get('/versions/:versionId/stats', async (req, res) => {
    try {
      const { versionId } = req.params;
      const { repo, version } = req.query;
      const externalVersion = String(version || versionId);
      if (!repo || !externalVersion) {
        return res.status(400).json({ error: 'Missing query parameters: repo, version' });
      }

      const { db, qb } = await openQueryBuilder(String(repo), externalVersion);
      try {
        const stats = await qb.getStats();
        return res.json(stats);
      } finally {
        await db.close();
      }
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // DELETE /api/v1/versions/:versionId
  router.delete('/versions/:versionId', async (req, res) => {
    try {
      const { versionId } = req.params;
      const { repo, version } = req.query;
      const externalVersion = String(version || versionId);
      if (!repo || !externalVersion) {
        return res.status(400).json({ error: 'Missing query parameters: repo, version' });
      }

      const repoStr = String(repo);
      const versionStr = externalVersion;
      const dbPath = resolveDbPath(repoStr, versionStr);
      const { db } = await openQueryBuilder(repoStr, versionStr);
      await db.close();
      await fs.promises.rm(dbPath, { force: true });
      await fs.promises.rm(`${dbPath}-wal`, { force: true });
      await fs.promises.rm(`${dbPath}-shm`, { force: true });
      await fs.promises.rm(`${dbPath}-journal`, { force: true });
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return router;
}
