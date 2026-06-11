import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import * as path from 'path';
import { runMigrations } from '../../src/schema/migrate';

describe('MySQL Schema Migrations', () => {
  let connection: mysql.Connection;

  const dbConfig = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: 'codegraph_test_migrate', // Distinct database name to prevent test interference
  };

  beforeAll(async () => {
    // Connect to MySQL server first (without database to ensure we can recreate it)
    const initConn = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
    });

    // Drop and recreate test database
    await initConn.query(`DROP DATABASE IF EXISTS \`${dbConfig.database}\``);
    await initConn.query(`CREATE DATABASE \`${dbConfig.database}\``);
    await initConn.end();

    // Connect to the fresh test database
    connection = await mysql.createConnection(dbConfig);
  }, 30000);

  afterAll(async () => {
    if (connection) {
      await connection.end();
    }
  });

  it('should run migrations successfully and create all tables', async () => {
    // 1. Run migrations
    const migrationDir = path.join(__dirname, '../../src/schema');
    await runMigrations(connection, migrationDir);

    // 2. Verify tables were created
    const [rows] = await connection.query('SHOW TABLES');
    expect(rows).toBeInstanceOf(Array);
    const tableNames = (rows as any[]).map(row => Object.values(row)[0] as string);

    const expectedTables = [
      'active_versions',
      'version_history',
      'nodes',
      'edges',
      'files',
      'unresolved_refs',
      'project_metadata',
      'schema_versions',
    ];

    for (const table of expectedTables) {
      expect(tableNames).toContain(table);
    }

    // 3. Verify version history tracked in schema_versions
    const [versionRows] = await connection.query('SELECT * FROM schema_versions');
    expect(versionRows).toBeInstanceOf(Array);
    expect(versionRows).toHaveLength(1);
    expect((versionRows as any[])[0].version).toBe(1);
  }, 30000);

  it('should be idempotent and skip already applied migrations', async () => {
    const migrationDir = path.join(__dirname, '../../src/schema');
    
    // Running again should not throw any errors
    await expect(runMigrations(connection, migrationDir)).resolves.not.toThrow();

    // Verify it didn't add duplicate entries in schema_versions
    const [versionRows] = await connection.query('SELECT * FROM schema_versions');
    expect(versionRows).toHaveLength(1);
  }, 30000);
});
