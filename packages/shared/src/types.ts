export interface QueryContext {
  repo: string;
  version: string;
  versionId: string;
}

export interface DatabaseLike {
  dialect: 'sqlite';
  execute(sql: string, params?: any[]): Promise<any>;
  query(sql: string, params?: any[]): Promise<any[]>;
  transaction<T>(fn: (conn: any) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
