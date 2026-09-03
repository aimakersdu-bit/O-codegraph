import * as fs from 'fs';
import * as path from 'path';
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

export function dbExists(repo: string, version: string): boolean {
  return fs.existsSync(resolveDbPath(repo, version));
}

export function listDbFiles(rootDir = getDbRoot()): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.db')) {
        result.push(full);
      }
    }
  };
  walk(rootDir);
  return result;
}
