import * as mysql from 'mysql2/promise';
import { MysqlConfig, MysqlDatabase } from './types';

export class MysqlDatabaseImpl implements MysqlDatabase {
  private pool: mysql.Pool;

  constructor(config: MysqlConfig) {
    this.pool = mysql.createPool({
      host: config.host || 'localhost',
      port: config.port || 3306,
      user: config.user || 'root',
      password: config.password || 'root',
      database: config.database || 'codegraph',
      connectionLimit: config.connectionLimit || 10,
      // Support executing multiple statements (required for migrations)
      multipleStatements: true,
    });
  }

  async execute(sql: string, params?: any[]): Promise<any> {
    const [result] = await this.pool.execute(sql, params);
    return result;
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as any[];
  }

  async transaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class TransactionDatabaseWrapper implements MysqlDatabase {
  constructor(private conn: mysql.PoolConnection) {}

  async execute(sql: string, params?: any[]): Promise<any> {
    const [result] = await this.conn.execute(sql, params);
    return result;
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    const [rows] = await this.conn.query(sql, params);
    return rows as any[];
  }

  async transaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    return fn(this.conn);
  }

  async close(): Promise<void> {
    // No-op
  }
}
