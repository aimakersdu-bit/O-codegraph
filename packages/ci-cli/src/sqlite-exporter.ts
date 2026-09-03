import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { FileRecord, Edge, Node } from '@colbymchenry/codegraph';
import { QueryBuilder, SqliteDatabaseImpl, getRepoVersionDbName } from '@codegraph/shared';
import { IngestionPayload } from './uploader';

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

async function createSchema(db: SqliteDatabaseImpl): Promise<void> {
  await db.execute(`PRAGMA journal_mode = DELETE`);
  await db.execute(`
      CREATE TABLE IF NOT EXISTS active_versions (
        repo        TEXT NOT NULL,
        version      TEXT NOT NULL,
        version_id  TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (repo, version)
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS version_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        repo        TEXT NOT NULL,
        version      TEXT NOT NULL,
        version_id  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        node_count  INTEGER DEFAULT 0,
        edge_count  INTEGER DEFAULT 0,
        file_count  INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL,
        deleted_at  INTEGER,
        UNIQUE (repo, version, version_id)
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS nodes (
        id              TEXT NOT NULL,
        repo            TEXT NOT NULL,
        version          TEXT NOT NULL,
        version_id      TEXT NOT NULL,
        kind            TEXT NOT NULL,
        name            TEXT NOT NULL,
        qualified_name  TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        language        TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        start_column    INTEGER NOT NULL,
        end_column      INTEGER NOT NULL,
        docstring       TEXT,
        signature       TEXT,
        source_code     TEXT,
        visibility      TEXT,
        is_exported     INTEGER DEFAULT 0,
        is_async        INTEGER DEFAULT 0,
        is_static       INTEGER DEFAULT 0,
        is_abstract     INTEGER DEFAULT 0,
        decorators      TEXT,
        type_parameters TEXT,
        updated_at      INTEGER NOT NULL,
        UNIQUE (repo, version, version_id, id)
      )
    `);
    await db.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
      USING fts5(node_id UNINDEXED, name, qualified_name, docstring, signature)
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS edges (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        repo        TEXT NOT NULL,
        version      TEXT NOT NULL,
        version_id  TEXT NOT NULL,
        source      TEXT NOT NULL,
        target      TEXT NOT NULL,
        kind        TEXT NOT NULL,
        metadata    TEXT,
        line        INTEGER,
        col         INTEGER,
        provenance  TEXT
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS files (
        path          TEXT NOT NULL,
        repo          TEXT NOT NULL,
        version        TEXT NOT NULL,
        version_id    TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        language      TEXT NOT NULL,
        size          INTEGER NOT NULL,
        modified_at   INTEGER NOT NULL,
        indexed_at    INTEGER NOT NULL,
        node_count    INTEGER DEFAULT 0,
        errors        TEXT,
        PRIMARY KEY (repo, version, version_id, path)
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS unresolved_refs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        repo            TEXT NOT NULL,
        version          TEXT NOT NULL,
        version_id      TEXT NOT NULL,
        from_node_id    TEXT NOT NULL,
        reference_name  TEXT NOT NULL,
        reference_kind  TEXT NOT NULL,
        line            INTEGER NOT NULL,
        col             INTEGER NOT NULL,
        candidates      TEXT,
        file_path       TEXT NOT NULL DEFAULT '',
        language        TEXT NOT NULL DEFAULT 'unknown'
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS project_metadata (
        repo        TEXT NOT NULL,
        version      TEXT NOT NULL,
        version_id  TEXT NOT NULL,
        "key"       TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (repo, version, version_id, "key")
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS export_metadata (
        repo                 TEXT NOT NULL,
        version               TEXT NOT NULL,
        version_id           TEXT NOT NULL,
        generated_at         INTEGER NOT NULL,
        source_project_root  TEXT NOT NULL,
        codegraph_version    TEXT NOT NULL
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        version     INTEGER PRIMARY KEY,
        applied_at  INTEGER NOT NULL,
        description TEXT
      )
    `);
}

function buildDbPath(outputDir: string, repo: string, version: string): string {
  return path.join(outputDir, getRepoVersionDbName(repo, version));
}

export async function exportPayloadToSqlite(params: {
  outputDir: string;
  payload: IngestionPayload;
  sourceProjectRoot: string;
  codegraphVersion: string;
}): Promise<{ dbPath: string; versionId: string }> {
  const { outputDir, payload, sourceProjectRoot, codegraphVersion } = params;
  const versionId = randomUUID();
  const dbPath = buildDbPath(outputDir, payload.repo, payload.version);

  ensureDir(outputDir);
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(`${dbPath}-journal`, { force: true });

  const db = new SqliteDatabaseImpl(dbPath);
  try {
    await createSchema(db);

    const qb = new QueryBuilder(db, { repo: payload.repo, version: payload.version, versionId });
    const now = Date.now();

    await qb.insertNodes(payload.nodes as Array<Node & { sourceCode?: string }>);
    await qb.insertEdges(payload.edges as Edge[]);
    if (payload.files.length > 0) {
      for (const file of payload.files as FileRecord[]) {
        await qb.upsertFile(file);
      }
    }
    if (payload.metadata) {
      for (const [key, value] of Object.entries(payload.metadata)) {
        await qb.setMetadata(key, value);
      }
    }

    await db.execute(
      'INSERT OR REPLACE INTO active_versions (repo, version, version_id, updated_at) VALUES (?, ?, ?, ?)',
      [payload.repo, payload.version, versionId, now]
    );
    await db.execute(
      'INSERT INTO version_history (repo, version, version_id, status, node_count, edge_count, file_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [payload.repo, payload.version, versionId, 'active', payload.nodes.length, payload.edges.length, payload.files.length, now]
    );
    await db.execute(
      'INSERT INTO export_metadata (repo, version, version_id, generated_at, source_project_root, codegraph_version) VALUES (?, ?, ?, ?, ?, ?)',
      [payload.repo, payload.version, versionId, now, sourceProjectRoot, codegraphVersion]
    );
    await db.execute(
      'INSERT OR REPLACE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
      [1, now, 'ci-cli export schema']
    );

    await db.execute('DELETE FROM nodes_fts');
    await db.execute(`
      INSERT INTO nodes_fts(node_id, name, qualified_name, docstring, signature)
      SELECT id, name, qualified_name, docstring, signature FROM nodes
    `);

    return { dbPath, versionId };
  } catch (err) {
    await db.close().catch(() => undefined);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.rmSync(`${dbPath}-journal`, { force: true });
    throw err;
  } finally {
    await db.close();
  }
}
