import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { MysqlDatabaseImpl, QueryBuilder, runMigrations } from '@codegraph/shared';
import * as path from 'path';

describe('Ingestion Server Integration Tests', () => {
  let db: MysqlDatabaseImpl;
  let app: any;
  let appDb: any;
  let testDbConfig: any;

  beforeAll(async () => {
    // Set test configuration before importing app
    process.env.MYSQL_DATABASE = 'codegraph_test_ingestion';
    process.env.CODEGRAPH_API_KEY = 'test-api-key';

    // Dynamically import the app after environment variables are set
    const appModule = await import('../src/index');
    app = appModule.app;
    appDb = appModule.db;
    const dbConfig = appModule.dbConfig;

    testDbConfig = {
      ...dbConfig,
      database: 'codegraph_test_ingestion',
    };

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

    // 3. Initialize test db client
    db = new MysqlDatabaseImpl(testDbConfig);
  }, 30000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    if (appDb) {
      await appDb.close();
    }
  });

  const fixtureNodes = [
    {
      id: 'n1',
      kind: 'function',
      name: 'hello',
      qualifiedName: 'hello',
      filePath: 'hello.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 1,
      endColumn: 10,
      docstring: 'says hello',
      signature: 'function hello()',
      sourceCode: 'function hello() {\n  console.log("hello");\n}',
      visibility: 'public' as const,
      isExported: true,
      updatedAt: Date.now(),
    },
  ];

  const fixtureEdges = [
    {
      source: 'n1',
      target: 'n2',
      kind: 'calls',
      line: 3,
      column: 5,
      provenance: 'static' as const,
      metadata: {},
    },
  ];

  const fixtureFiles = [
    {
      path: 'hello.ts',
      contentHash: 'h1',
      language: 'typescript' as const,
      size: 100,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 1,
      errors: [],
    },
  ];

  it('should return 401 if unauthorized', async () => {
    const res = await request(app)
      .post('/api/v1/ingest')
      .send({
        repo: 'test/repo',
        branch: 'main',
        nodes: [],
        edges: [],
        files: [],
      });
    expect(res.status).toBe(401);
  });

  it('should successfully ingest graph data', async () => {
    const res = await request(app)
      .post('/api/v1/ingest')
      .set('Authorization', 'Bearer test-api-key')
      .send({
        repo: 'test/repo',
        branch: 'main',
        nodes: fixtureNodes,
        edges: fixtureEdges,
        files: fixtureFiles,
        metadata: { buildId: '123' },
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.versionId).toBeDefined();

    const versionId = res.body.versionId;

    // Verify it is set in active_versions
    const activeRows = await db.query(
      'SELECT version_id FROM active_versions WHERE repo = ? AND branch = ?',
      ['test/repo', 'main']
    );
    expect(activeRows[0].version_id).toBe(versionId);

    // Verify data in nodes, edges, files, metadata
    const qb = new QueryBuilder(db, { repo: 'test/repo', branch: 'main', versionId });
    const node = await qb.getNodeById('n1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('hello');
    expect(await qb.getNodeSourceCode('n1')).toBe(fixtureNodes[0].sourceCode);

    const edges = await qb.getOutgoingEdges('n1');
    expect(edges).toHaveLength(1);
    expect(edges[0].target).toBe('n2');

    const file = await qb.getFileByPath('hello.ts');
    expect(file).not.toBeNull();
    expect(file!.contentHash).toBe('h1');

    const metaVal = await qb.getMetadata('buildId');
    expect(metaVal).toBe('123');
  });

  it('should support listing versions and manual delete', async () => {
    // Post another version to test listing and deleting
    const res = await request(app)
      .post('/api/v1/ingest')
      .set('Authorization', 'Bearer test-api-key')
      .send({
        repo: 'test/repo',
        branch: 'main',
        nodes: fixtureNodes,
        edges: [],
        files: [],
      });
    expect(res.status).toBe(201);
    const newVersionId = res.body.versionId;

    // List versions
    const listRes = await request(app)
      .get('/api/v1/versions?repo=test/repo&branch=main')
      .set('Authorization', 'Bearer test-api-key');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(2);

    // Get stats of the new version
    const statsRes = await request(app)
      .get(`/api/v1/versions/${newVersionId}/stats?repo=test/repo&branch=main`)
      .set('Authorization', 'Bearer test-api-key');
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.nodeCount).toBe(1);

    // Delete the new version
    const delRes = await request(app)
      .delete(`/api/v1/versions/${newVersionId}?repo=test/repo&branch=main`)
      .set('Authorization', 'Bearer test-api-key');
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    // Verify it is gone
    const listResAfter = await request(app)
      .get('/api/v1/versions?repo=test/repo&branch=main')
      .set('Authorization', 'Bearer test-api-key');
    expect(listResAfter.body).toHaveLength(1);
  });

  it('should keep at most 7 versions and clean up older ones', async () => {
    const versionIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post('/api/v1/ingest')
        .set('Authorization', 'Bearer test-api-key')
        .send({
          repo: 'test/repo-cleanup',
          branch: 'main',
          nodes: fixtureNodes,
          edges: [],
          files: [],
        });
      expect(res.status).toBe(201);
      versionIds.push(res.body.versionId);
    }

    // Wait slightly for async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Get version list
    const listRes = await request(app)
      .get('/api/v1/versions?repo=test/repo-cleanup&branch=main')
      .set('Authorization', 'Bearer test-api-key');

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeLessThanOrEqual(7);

    // Verify that the oldest version was cleaned up
    const oldestVersionId = versionIds[0];
    const oldNode = await db.query(
      'SELECT id FROM nodes WHERE repo = ? AND version_id = ?',
      ['test/repo-cleanup', oldestVersionId]
    );
    expect(oldNode).toHaveLength(0);
  });
});
