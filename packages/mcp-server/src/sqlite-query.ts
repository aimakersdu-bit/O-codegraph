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
