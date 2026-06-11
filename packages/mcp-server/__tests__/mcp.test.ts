import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import { MysqlDatabaseImpl, QueryBuilder, runMigrations } from '@codegraph/shared';
import { ToolHandler } from '../src/tool-handler';
import * as path from 'path';

describe('Unified MCP Server integration tests', () => {
  let db: MysqlDatabaseImpl;
  let handler: ToolHandler;
  const testDbConfig = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: 'codegraph_test_mcp',
  };

  const versionId = 'test-version-id-123';
  const repo = 'test/mcp-repo';
  const branch = 'main';

  beforeAll(async () => {
    // 1. Recreate test database
    const initConn = await mysql.createConnection({
      host: testDbConfig.host,
      port: testDbConfig.port,
      user: testDbConfig.user,
      password: testDbConfig.password,
    });
    await initConn.query(`DROP DATABASE IF EXISTS \`${testDbConfig.database}\``);
    await initConn.query(`CREATE DATABASE \`${testDbConfig.database}\``);
    await initConn.end();

    // 2. Run migrations
    const conn = await mysql.createConnection(testDbConfig);
    const migrationDir = path.resolve(__dirname, '../../shared/src/schema');
    await runMigrations(conn, migrationDir);
    await conn.end();

    // 3. Initialize DB and Handler
    db = new MysqlDatabaseImpl(testDbConfig);
    handler = new ToolHandler(db);

    // 4. Seed mock data
    await db.execute(
      'INSERT INTO active_versions (repo, branch, version_id, updated_at) VALUES (?, ?, ?, ?)',
      [repo, branch, versionId, Date.now()]
    );
    await db.execute(
      'INSERT INTO version_history (repo, branch, version_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [repo, branch, versionId, 'active', Date.now()]
    );

    const qb = new QueryBuilder(db, { repo, branch, versionId });
    await qb.insertNode({
      id: 'node-1',
      kind: 'function',
      name: 'calculateTotal',
      qualifiedName: 'calculateTotal',
      filePath: 'src/math.ts',
      language: 'typescript',
      startLine: 10,
      endLine: 15,
      startColumn: 1,
      endColumn: 20,
      docstring: 'Sums two values',
      signature: 'function calculateTotal(a, b)',
      isExported: true,
      updatedAt: Date.now(),
    }, '/**\n * Sums two values\n */\nfunction calculateTotal(a, b) {\n  return a + b;\n}');

    await qb.insertNode({
      id: 'node-2',
      kind: 'function',
      name: 'renderPage',
      qualifiedName: 'renderPage',
      filePath: 'src/render.ts',
      language: 'typescript',
      startLine: 20,
      endLine: 25,
      startColumn: 1,
      endColumn: 20,
      isExported: true,
      updatedAt: Date.now(),
    }, 'function renderPage() {\n  const total = calculateTotal(10, 20);\n  console.log(total);\n}');

    await qb.insertEdge({
      source: 'node-2',
      target: 'node-1',
      kind: 'calls',
      line: 21,
      column: 17,
      provenance: 'static',
    });

    await qb.upsertFile({
      path: 'src/math.ts',
      contentHash: 'hash-math',
      language: 'typescript',
      size: 100,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 1,
      errors: [],
    });

    await qb.upsertFile({
      path: 'src/render.ts',
      contentHash: 'hash-render',
      language: 'typescript',
      size: 200,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 1,
      errors: [],
    });
  });

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it('should run codegraph_search and find matching symbols', async () => {
    const res = await handler.execute('codegraph_search', {
      repo,
      branch,
      query: 'calculate',
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('calculateTotal');
  });

  it('should run codegraph_callers and return callers', async () => {
    const res = await handler.execute('codegraph_callers', {
      repo,
      branch,
      symbol: 'calculateTotal',
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('renderPage');
  });

  it('should run codegraph_explore and return verbatim code context', async () => {
    const res = await handler.execute('codegraph_explore', {
      repo,
      branch,
      query: 'calculateTotal',
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('calculateTotal');
    expect(res.content[0].text).toContain('Sums two values');
  });

  it('should run codegraph_versions and list available versions', async () => {
    const res = await handler.execute('codegraph_versions', {
      repo,
      branch,
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain(versionId);
  });
});
