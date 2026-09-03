import { DatabaseLike } from './types';

type SqliteRow = Record<string, any>;

function openDatabaseSync(dbPath: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath);
}

export class SqliteDatabaseImpl implements DatabaseLike {
  public readonly dialect = 'sqlite' as const;
  private db: any;

  constructor(dbPath: string) {
    this.db = openDatabaseSync(dbPath);
  }

  async execute(sql: string, params?: any[]): Promise<any> {
    const stmt = this.db.prepare(sql);
    return stmt.run(...(params ?? []));
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params ?? [])) as SqliteRow[];
  }

  async transaction<T>(fn: (conn: DatabaseLike) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    const wrapper = new SqliteTransactionWrapper(this.db);
    try {
      const result = await fn(wrapper);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures after a failed transaction.
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export class SqliteTransactionWrapper implements DatabaseLike {
  public readonly dialect = 'sqlite' as const;

  constructor(private db: any) {}

  async execute(sql: string, params?: any[]): Promise<any> {
    const stmt = this.db.prepare(sql);
    return stmt.run(...(params ?? []));
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params ?? [])) as SqliteRow[];
  }

  async transaction<T>(fn: (conn: DatabaseLike) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    return;
  }
}
