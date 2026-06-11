import * as mysql from 'mysql2/promise';

export interface QueryContext {
  repo: string;
  branch: string;
  versionId: string;
}

export interface MysqlConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionLimit?: number; // pool size
}

export interface MysqlDatabase {
  execute(sql: string, params?: any[]): Promise<any>;
  query(sql: string, params?: any[]): Promise<any[]>;
  transaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
