import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import { MysqlDatabaseImpl, QueryBuilder, runMigrations } from '@codegraph/shared';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/index.js');

describe('Unified MCP Server HTTP REST API integration', () => {
  let db: MysqlDatabaseImpl;
  let child: ChildProcessWithoutNullStreams | null = null;
  const PORT = 6124;

  const testDbConfig = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: 'codegraph_test_mcp_http',
  };

  const versionId = 'test-version-id-456';
  const repo = 'test/mcp-repo-http';
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

    // 3. Initialize DB
    db = new MysqlDatabaseImpl(testDbConfig);

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
      name: 'helloWorld',
      qualifiedName: 'helloWorld',
      filePath: 'src/main.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 1,
      endColumn: 20,
      docstring: 'Says hello',
      signature: 'function helloWorld()',
      isExported: true,
      updatedAt: Date.now(),
    }, 'function helloWorld() {\n  return "Hello World";\n}');

    // 5. Spawn the central mcp-server in SSE mode
    child = spawn(process.execPath, [BIN], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_MODE: 'sse',
        MCP_PORT: String(PORT),
        MYSQL_HOST: testDbConfig.host,
        MYSQL_PORT: String(testDbConfig.port),
        MYSQL_USER: testDbConfig.user,
        MYSQL_PASSWORD: testDbConfig.password,
        MYSQL_DATABASE: testDbConfig.database,
      },
    });

    // Wait for Express server startup log on stderr
    let output = '';
    const listeningPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for SSE server to start. Stderr: ' + output)), 15000);
      child!.stderr.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output.includes('SSE transport listening on port')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await listeningPromise;
  });

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    if (db) {
      await db.close();
    }
  });

  it('serves GET /api metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.name).toBe('codegraph-central-mcp');
    expect(data.mode).toBe('sse');
  });

  it('serves GET /api/tools list', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/tools`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.some((t: any) => t.name === 'codegraph_search')).toBe(true);
  });

  it('handles POST /api/search with valid repo/branch params', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo,
        branch,
        query: 'hello',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.isError).toBeUndefined();
    expect(data.content[0].text).toContain('helloWorld');
  });

  it('handles generic POST /api/tools/:name execution', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/tools/codegraph_versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repo,
        branch,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.isError).toBeUndefined();
    expect(data.content[0].text).toContain(versionId);
  });

  it('rejects query without repo and branch with 422 error', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'hello',
      }),
    });
    expect(res.status).toBe(422);
    const data = await res.json() as any;
    expect(data.content[0].text).toContain('Missing repo or branch parameter');
  });
});
