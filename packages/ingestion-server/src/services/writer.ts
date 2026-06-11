import { MysqlDatabase, QueryBuilder, TransactionDatabaseWrapper } from '@codegraph/shared';
import { Node, Edge, FileRecord } from '@colbymchenry/codegraph';
import { v4 as uuidv4 } from 'uuid';
import { VersionCleaner } from './cleaner';

/**
 * Generates a valid UUID v7 string based on current timestamp and random bytes.
 */
export function generateUuidV7(): string {
  const now = Date.now();
  const hexTime = now.toString(16).padStart(12, '0'); // 48 bits of timestamp
  const randomPart = uuidv4().replace(/-/g, '').substring(12); // remaining 80 bits of random

  const time1 = hexTime.substring(0, 8);
  const time2 = hexTime.substring(8, 12);
  const rand1 = '7' + randomPart.substring(1, 4); // set version to 7
  const rand2 = '8' + randomPart.substring(5, 8); // set variant to 8
  const rand3 = randomPart.substring(8, 20);

  return `${time1}-${time2}-${rand1}-${rand2}-${rand3}`;
}

export class WriterService {
  private cleaner: VersionCleaner;

  constructor(private db: MysqlDatabase) {
    this.cleaner = new VersionCleaner(db);
  }

  /**
   * Helper to write items in batches.
   */
  private async batchWrite<T>(
    items: T[],
    batchSize: number,
    writeFn: (batch: T[]) => Promise<void>
  ): Promise<void> {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await writeFn(batch);
    }
  }

  /**
   * Ingests a full codebase version.
   */
  async ingestVersion(params: {
    repo: string;
    branch: string;
    nodes: Array<Node & { sourceCode?: string }>;
    edges: Edge[];
    files: FileRecord[];
    metadata?: Record<string, string>;
  }): Promise<string> {
    const { repo, branch, nodes, edges, files, metadata = {} } = params;
    const versionId = generateUuidV7();

    // 1. Create a version history record
    await this.db.execute(
      'INSERT INTO version_history (repo, branch, version_id, status, node_count, edge_count, file_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [repo, branch, versionId, 'active', nodes.length, edges.length, files.length, Date.now()]
    );

    const qb = new QueryBuilder(this.db, { repo, branch, versionId });

    // 2. Batch write nodes (500 per batch)
    // Extract source codes
    const nodeSourceCodes = new Map<string, string>();
    for (const node of nodes) {
      if (node.sourceCode !== undefined) {
        nodeSourceCodes.set(node.id, node.sourceCode);
      }
    }

    await this.batchWrite(nodes, 500, async (batch) => {
      await qb.insertNodes(batch, nodeSourceCodes);
    });

    // 3. Batch write edges (500 per batch)
    await this.batchWrite(edges, 500, async (batch) => {
      await qb.insertEdges(batch);
    });

    // 4. Batch write files
    if (files.length > 0) {
      await this.db.transaction(async (conn) => {
        const fileQb = new QueryBuilder(new TransactionDatabaseWrapper(conn), { repo, branch, versionId });
        for (const file of files) {
          await fileQb.upsertFile(file);
        }
      });
    }

    // 5. Write metadata
    const metadataEntries = Object.entries(metadata);
    if (metadataEntries.length > 0) {
      await this.db.transaction(async (conn) => {
        const metaQb = new QueryBuilder(new TransactionDatabaseWrapper(conn), { repo, branch, versionId });
        for (const [key, value] of metadataEntries) {
          await metaQb.setMetadata(key, value);
        }
      });
    }

    // 6. Atomically switch active version pointer in active_versions
    await this.db.execute(
      `INSERT INTO active_versions (repo, branch, version_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE version_id = VALUES(version_id), updated_at = VALUES(updated_at)`,
      [repo, branch, versionId, Date.now()]
    );

    // 7. Update status of the older active versions to 'retained'
    await this.db.execute(
      'UPDATE version_history SET status = ? WHERE repo = ? AND branch = ? AND version_id != ? AND status = ?',
      ['retained', repo, branch, versionId, 'active']
    );

    // 8. Trigger async cleanup (do not await)
    this.cleaner.cleanupOldVersions(repo, branch).catch((err) => {
      console.error('[WriterService] Async cleanup failed:', err);
    });

    return versionId;
  }
}
