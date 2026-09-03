import * as path from 'path';

export function sanitizeDbComponent(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'default';
}

export function isValidExportVersion(version: string): boolean {
  return /^\d{6}\.\d+\.\d+\.\d+$/.test(version);
}

export function getRepoVersionDbName(repo: string, version: string): string {
  if (!isValidExportVersion(version)) {
    throw new Error(`Invalid version "${version}". Expected YYMMDD.major.minor.build, e.g. 260827.1.0.2233`);
  }
  return `${sanitizeDbComponent(repo)}_${sanitizeDbComponent(version)}.db`;
}

export function getRepoVersionDbPath(rootDir: string, repo: string, version: string): string {
  return path.join(rootDir, sanitizeDbComponent(repo), getRepoVersionDbName(repo, version));
}
