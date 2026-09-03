import * as fs from 'fs';
import { QueryBuilder, SqliteDatabaseImpl } from '@codegraph/shared';
import { resolveDbPath } from './sqlite-locator';

export async function openQueryBuilder(repo: string, version: string, versionId?: string) {
  const dbPath = resolveDbPath(repo, version);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found for ${repo}@${version}: ${dbPath}`);
  }
  const db = new SqliteDatabaseImpl(dbPath);
  const ctx = await QueryBuilder.resolveContext(db, repo, version, versionId);
  return { db, qb: new QueryBuilder(db, ctx), ctx, dbPath };
}

export async function readExportMetadata(repo: string, version: string): Promise<Record<string, string> | null> {
  const { db } = await openQueryBuilder(repo, version);
  try {
    const rows = await db.query(
      'SELECT generated_at, source_project_root, codegraph_version, version_id FROM export_metadata WHERE repo = ? AND version = ? ORDER BY generated_at DESC LIMIT 1',
      [repo, version]
    );
    if (!rows.length) return null;
    return rows[0];
  } finally {
    await db.close();
  }
}
