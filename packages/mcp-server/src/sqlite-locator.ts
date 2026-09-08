import * as path from 'path';
import * as fs from 'fs';
import { getRepoVersionDbPath } from '@codegraph/shared';

export function getDbRoot(): string {
  const envRoot = process.env.INGESTION_DB_ROOT || process.env.CODEGRAPH_DB_ROOT;
  if (envRoot) return envRoot;

  const candidates = [
    path.join(process.cwd(), 'codegraph-dbs'),
    path.join(process.cwd(), '..', 'codegraph-dbs'),
    path.join(process.cwd(), '..', '..', 'codegraph-dbs'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return path.join(process.cwd(), 'codegraph-dbs');
}

export function resolveDbPath(repo: string, version: string): string {
  return getRepoVersionDbPath(getDbRoot(), repo, version);
}
