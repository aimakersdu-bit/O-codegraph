import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import { MysqlDatabaseImpl } from '../src/mysql-adapter';
import { QueryBuilder } from '../src/queries';
import { runMigrations } from '../src/schema/migrate';
import { Node, Edge, FileRecord } from '@colbymchenry/codegraph';

describe('Shared MySQL QueryBuilder', () => {
  let db: MysqlDatabaseImpl;
  let queryBuilder: QueryBuilder;

  const dbConfig = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: 'codegraph_test_queries',
  };

  const context = {
    repo: 'test-org/test-repo',
    branch: 'main',
    versionId: 'v-test-1',
  };

  beforeAll(async () => {
    // 1. Recreate database
    const initConn = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    await initConn.query(`DROP DATABASE IF EXISTS \`${dbConfig.database}\``);
    await initConn.query(`CREATE DATABASE \`${dbConfig.database}\``);
    await initConn.end();

    // 2. Run schema migrations
    const conn = await mysql.createConnection(dbConfig);
    const migrationDir = `${__dirname}/../src/schema`;
    await runMigrations(conn, migrationDir);
    await conn.end();

    // 3. Connect via our adapter
    db = new MysqlDatabaseImpl(dbConfig);
    queryBuilder = new QueryBuilder(db, context);

    // Seed version history to pass context checks
    await db.execute(
      'INSERT INTO version_history (repo, branch, version_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [context.repo, context.branch, context.versionId, 'active', Date.now()]
    );
    await db.execute(
      'INSERT INTO active_versions (repo, branch, version_id, updated_at) VALUES (?, ?, ?, ?)',
      [context.repo, context.branch, context.versionId, Date.now()]
    );
  }, 30000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  it('should support Node CRUD and source code retrieval', async () => {
    const node: Node = {
      id: 'node-1',
      kind: 'function',
      name: 'calculateSum',
      qualifiedName: 'math.calculateSum',
      filePath: 'src/math.ts',
      language: 'typescript',
      startLine: 10,
      endLine: 15,
      startColumn: 1,
      endColumn: 20,
      docstring: 'Calculates sum of two numbers',
      signature: 'calculateSum(a: number, b: number): number',
      visibility: 'public',
      isExported: true,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      decorators: ['@deprecated'],
      typeParameters: [],
      updatedAt: Date.now(),
    };

    const sourceCode = 'function calculateSum(a: number, b: number) {\n  return a + b;\n}';

    // 1. Insert
    await queryBuilder.insertNode(node, sourceCode);

    // 2. Retrieve by ID
    const retrieved = await queryBuilder.getNodeById('node-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('calculateSum');
    expect(retrieved!.decorators).toEqual(['@deprecated']);

    // 3. Retrieve source code
    const code = await queryBuilder.getNodeSourceCode('node-1');
    expect(code).toBe(sourceCode);

    // 4. Update
    node.name = 'calculateSumUpdated';
    await queryBuilder.updateNode(node, 'updated source code');

    const updated = await queryBuilder.getNodeById('node-1');
    expect(updated!.name).toBe('calculateSumUpdated');
    expect(await queryBuilder.getNodeSourceCode('node-1')).toBe('updated source code');

    // 5. Delete
    await queryBuilder.deleteNode('node-1');
    expect(await queryBuilder.getNodeById('node-1')).toBeNull();
  });

  it('should support Edge CRUD', async () => {
    const edge: Edge = {
      source: 'node-caller',
      target: 'node-callee',
      kind: 'calls',
      line: 5,
      column: 12,
      provenance: 'static',
      metadata: { importance: 'high' },
    };

    // 1. Insert
    await queryBuilder.insertEdge(edge);

    // 2. Outgoing
    const outgoing = await queryBuilder.getOutgoingEdges('node-caller');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].target).toBe('node-callee');
    expect(outgoing[0].metadata).toEqual({ importance: 'high' });

    // 3. Incoming
    const incoming = await queryBuilder.getIncomingEdges('node-callee');
    expect(incoming).toHaveLength(1);
    expect(incoming[0].source).toBe('node-caller');

    // 4. Delete by source
    await queryBuilder.deleteEdgesBySource('node-caller');
    expect(await queryBuilder.getOutgoingEdges('node-caller')).toHaveLength(0);
  });

  it('should support File Record CRUD', async () => {
    const file: FileRecord = {
      path: 'src/main.ts',
      contentHash: 'hash123',
      language: 'typescript',
      size: 400,
      modifiedAt: Date.now(),
      indexedAt: Date.now(),
      nodeCount: 3,
      errors: [],
    };

    // 1. Upsert
    await queryBuilder.upsertFile(file);

    // 2. Get by path
    const retrieved = await queryBuilder.getFileByPath('src/main.ts');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.contentHash).toBe('hash123');

    // 3. Get all files
    const all = await queryBuilder.getAllFiles();
    expect(all).toHaveLength(1);
    expect(all[0].path).toBe('src/main.ts');

    // 4. Delete
    await queryBuilder.deleteFile('src/main.ts');
    expect(await queryBuilder.getFileByPath('src/main.ts')).toBeNull();
  });

  it('should support context resolution', async () => {
    // 1. Resolve active version (omit versionId)
    const activeCtx = await QueryBuilder.resolveContext(db, context.repo, context.branch);
    expect(activeCtx.versionId).toBe(context.versionId);

    // 2. Resolve specific versionId
    const resolvedCtx = await QueryBuilder.resolveContext(db, context.repo, context.branch, context.versionId);
    expect(resolvedCtx.versionId).toBe(context.versionId);

    // 3. Unknown versionId should throw
    await expect(QueryBuilder.resolveContext(db, context.repo, context.branch, 'v-unknown'))
      .rejects.toThrow();
  });

  it('should support FULLTEXT and LIKE searches', async () => {
    const nodeA: Node = {
      id: 'node-search-1',
      kind: 'class',
      name: 'AuthenticationService',
      qualifiedName: 'auth.AuthenticationService',
      filePath: 'src/auth.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 50,
      startColumn: 1,
      endColumn: 1,
      docstring: 'Handles user login and signup requests',
      signature: 'class AuthenticationService',
      updatedAt: Date.now(),
    };

    const nodeB: Node = {
      id: 'node-search-2',
      kind: 'function',
      name: 'logOutUser',
      qualifiedName: 'auth.logOutUser',
      filePath: 'src/auth.ts',
      language: 'typescript',
      startLine: 60,
      endLine: 65,
      startColumn: 1,
      endColumn: 1,
      docstring: 'Logs the current user out',
      signature: 'function logOutUser()',
      updatedAt: Date.now(),
    };

    await queryBuilder.insertNode(nodeA);
    await queryBuilder.insertNode(nodeB);

    // 1. FULLTEXT match search
    const ftsRes = await queryBuilder.searchNodes('user login');
    expect(ftsRes).not.toHaveLength(0);
    expect(ftsRes[0].node.id).toBe('node-search-1'); // matches 'login' in docstring

    // 2. LIKE search fallback
    const likeRes = await queryBuilder.searchNodes('logOut');
    expect(likeRes).not.toHaveLength(0);
    expect(likeRes[0].node.id).toBe('node-search-2'); // matches 'logOutUser'

    // Clean up
    await queryBuilder.deleteNode('node-search-1');
    await queryBuilder.deleteNode('node-search-2');
  }, 30000);
});
