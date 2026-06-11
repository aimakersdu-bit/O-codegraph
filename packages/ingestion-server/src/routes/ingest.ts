import { Router } from 'express';
import { MysqlDatabase } from '@codegraph/shared';
import { WriterService } from '../services/writer';

export function createIngestRouter(db: MysqlDatabase): Router {
  const router = Router();
  const writer = new WriterService(db);

  router.post('/ingest', async (req, res) => {
    try {
      const { repo, branch, nodes, edges, files, metadata } = req.body;

      if (!repo || !branch) {
        return res.status(400).json({ error: 'Missing required parameters: repo, branch' });
      }
      if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(files)) {
        return res.status(400).json({ error: 'nodes, edges, and files must be arrays' });
      }

      const versionId = await writer.ingestVersion({
        repo,
        branch,
        nodes,
        edges,
        files,
        metadata,
      });

      return res.status(201).json({
        success: true,
        versionId,
      });
    } catch (err: any) {
      console.error('[IngestRoute] Error during ingestion:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return router;
}
