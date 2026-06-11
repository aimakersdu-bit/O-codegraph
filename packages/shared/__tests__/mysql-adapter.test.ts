import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mysql from 'mysql2/promise';
import { MysqlDatabaseImpl } from '../src/mysql-adapter';

describe('MySQL Database Adapter', () => {
  let db: MysqlDatabaseImpl;

  const dbConfig = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: 'codegraph_test_adapter', // Distinct database name to prevent test interference
  };

  beforeAll(async () => {
    // Ensure the database exists
    const initConn = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
    });
    await initConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
    await initConn.end();

    db = new MysqlDatabaseImpl(dbConfig);
    // Create a temporary table for testing
    await db.execute(`
      CREATE TABLE IF NOT EXISTS test_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        email VARCHAR(100)
      ) ENGINE=InnoDB;
    `);
  }, 30000);

  afterAll(async () => {
    if (db) {
      await db.execute('DROP TABLE IF EXISTS test_users');
      await db.close();
    }
  });

  it('should support basic CRUD operations', async () => {
    // 1. Insert
    const insertRes = await db.execute(
      'INSERT INTO test_users (name, email) VALUES (?, ?)',
      ['Alice', 'alice@example.com']
    );
    expect(insertRes.affectedRows).toBe(1);
    const aliceId = insertRes.insertId;

    // 2. Select
    const rows = await db.query('SELECT * FROM test_users WHERE id = ?', [aliceId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Alice');
    expect(rows[0].email).toBe('alice@example.com');

    // 3. Update
    const updateRes = await db.execute(
      'UPDATE test_users SET email = ? WHERE id = ?',
      ['alice_new@example.com', aliceId]
    );
    expect(updateRes.affectedRows).toBe(1);

    const rowsUpdated = await db.query('SELECT email FROM test_users WHERE id = ?', [aliceId]);
    expect(rowsUpdated[0].email).toBe('alice_new@example.com');

    // 4. Delete
    const deleteRes = await db.execute('DELETE FROM test_users WHERE id = ?', [aliceId]);
    expect(deleteRes.affectedRows).toBe(1);

    const rowsAfterDelete = await db.query('SELECT * FROM test_users WHERE id = ?', [aliceId]);
    expect(rowsAfterDelete).toHaveLength(0);
  });

  it('should commit transaction successfully', async () => {
    const result = await db.transaction(async (conn) => {
      const [res] = await conn.execute(
        'INSERT INTO test_users (name, email) VALUES (?, ?)',
        ['Bob', 'bob@example.com']
      );
      const bobId = (res as any).insertId;
      return bobId;
    });

    expect(result).toBeGreaterThan(0);

    const rows = await db.query('SELECT * FROM test_users WHERE name = ?', ['Bob']);
    expect(rows).toHaveLength(1);
    
    // Clean up
    await db.execute('DELETE FROM test_users WHERE name = ?', ['Bob']);
  });

  it('should rollback transaction on error', async () => {
    let errorThrown = false;
    try {
      await db.transaction(async (conn) => {
        // Insert a user
        await conn.execute(
          'INSERT INTO test_users (name, email) VALUES (?, ?)',
          ['Charlie', 'charlie@example.com']
        );
        // Throw an error to trigger rollback
        throw new Error('Forced transaction rollback');
      });
    } catch (err: any) {
      if (err.message === 'Forced transaction rollback') {
        errorThrown = true;
      }
    }

    expect(errorThrown).toBe(true);

    // Verify Charlie was NOT inserted due to rollback
    const rows = await db.query('SELECT * FROM test_users WHERE name = ?', ['Charlie']);
    expect(rows).toHaveLength(0);
  });
});
