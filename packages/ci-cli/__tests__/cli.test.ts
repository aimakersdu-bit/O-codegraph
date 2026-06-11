import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as mysql from 'mysql2/promise';
import { extractAndBuildPayload } from '../src/extractor';
import { uploadPayload } from '../src/uploader';
import { MysqlDatabaseImpl, QueryBuilder, runMigrations } from '@codegraph/shared';

describe('CI-CLI End-to-End Integration Tests', () => {
  const scratchDir = path.resolve(__dirname, '../../../scratch/ci-test-repo');
  let server: any;
  let appDb: any;
  let db: MysqlDatabaseImpl;
  let ingestionUrl: string;
  let testDbConfig: any;

  beforeAll(async () => {
    // 1. Create a dummy project in workspace scratch directory
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    fs.mkdirSync(scratchDir, { recursive: true });

    // Write a dummy TypeScript file
    fs.writeFileSync(
      path.join(scratchDir, 'math.ts'),
      `/**\n * Adds two numbers.\n */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n`
    );

    // 2. Set up environment and database
    process.env.MYSQL_DATABASE = 'codegraph_test_cli';
    process.env.CODEGRAPH_API_KEY = 'cli-test-api-key';

    const appModule = await import('@codegraph/ingestion-server');
    const app = appModule.app;
    appDb = appModule.db;
    const dbConfig = appModule.dbConfig;

    testDbConfig = {
      ...dbConfig,
      database: 'codegraph_test_cli',
    };

    // Recreate database
    const initConn = await mysql.createConnection({
      host: testDbConfig.host,
      port: testDbConfig.port,
      user: testDbConfig.user,
      password: testDbConfig.password,
    });
    await initConn.query(`DROP DATABASE IF EXISTS \`${testDbConfig.database}\``);
    await initConn.query(`CREATE DATABASE \`${testDbConfig.database}\``);
    await initConn.end();

    // Run migrations
    const conn = await mysql.createConnection(testDbConfig);
    const migrationDir = path.resolve(__dirname, '../../shared/src/schema');
    await runMigrations(conn, migrationDir);
    await conn.end();

    // Initialize test client
    db = new MysqlDatabaseImpl(testDbConfig);

    // 3. Start local Ingestion Server
    server = app.listen(0);
    const address = server.address();
    const port = (address as any).port;
    ingestionUrl = `http://127.0.0.1:${port}`;
  }, 40000);

  afterAll(async () => {
    if (server) {
      server.close();
    }
    if (db) {
      await db.close();
    }
    if (appDb) {
      await appDb.close();
    }
    // Clean up temporary project
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('should successfully extract from project and upload to ingestion server', async () => {
    // 1. Run extractor
    const payload = await extractAndBuildPayload(scratchDir);
    expect(payload.nodes.length).toBeGreaterThan(0);
    expect(payload.files.length).toBe(1);
    expect(payload.files[0].path).toBe('math.ts');

    // Verify code snippet was extracted
    const addNode = payload.nodes.find((n) => n.name === 'add');
    expect(addNode).toBeDefined();
    expect(addNode!.sourceCode).toContain('export function add(a: number, b: number)');

    // Set repo and branch
    payload.repo = 'test/cli-repo';
    payload.branch = 'main';

    // 2. Upload payload
    const versionId = await uploadPayload(ingestionUrl, 'cli-test-api-key', payload);
    expect(versionId).toBeDefined();

    // 3. Verify in database
    const activeVersions = await db.query(
      'SELECT version_id FROM active_versions WHERE repo = ? AND branch = ?',
      ['test/cli-repo', 'main']
    );
    expect(activeVersions).toHaveLength(1);
    expect(activeVersions[0].version_id).toBe(versionId);

    const qb = new QueryBuilder(db, { repo: 'test/cli-repo', branch: 'main', versionId });
    const node = await qb.getNodeById(addNode!.id);
    expect(node).not.toBeNull();
    expect(node!.name).toBe('add');
    expect(await qb.getNodeSourceCode(addNode!.id)).toBe(addNode!.sourceCode);

    const file = await qb.getFileByPath('math.ts');
    expect(file).not.toBeNull();
    expect(file!.path).toBe('math.ts');
  });
});
