import * as fs from 'fs';
import * as path from 'path';
import * as mysql from 'mysql2/promise';

/**
 * Executes a SQL file by splitting its content into individual queries
 * and running them on the connection.
 */
async function executeSqlFile(connection: mysql.Connection, filePath: string): Promise<void> {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Remove single-line comments
  content = content.replace(/--.*$/gm, '');
  // Remove multi-line comments
  content = content.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Split statements by semicolon
  const statements = content
    .split(';')
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0);

  for (const statement of statements) {
    try {
      await connection.query(statement);
    } catch (err: any) {
      console.error(`Error executing statement in ${path.basename(filePath)}:`);
      console.error(statement);
      throw err;
    }
  }
}

/**
 * Checks if the schema_versions table exists, creating it if necessary.
 */
async function ensureSchemaVersionsTable(connection: mysql.Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version     INT PRIMARY KEY,
      applied_at  BIGINT NOT NULL,
      description TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

/**
 * Gets a list of applied schema versions.
 */
async function getAppliedVersions(connection: mysql.Connection): Promise<Set<number>> {
  const [rows] = await connection.query('SELECT version FROM schema_versions');
  const versions = new Set<number>();
  if (Array.isArray(rows)) {
    for (const row of rows as any[]) {
      versions.add(Number((row as any).version));
    }
  }
  return versions;
}

/**
 * Records an applied migration version in the database.
 */
async function recordAppliedVersion(
  connection: mysql.Connection,
  version: number,
  description: string
): Promise<void> {
  await connection.query(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)',
    [version, Date.now(), description]
  );
}

/**
 * Runs all pending migrations.
 * @param connection MySQL connection to run migrations on.
 * @param migrationDir Directory containing migration SQL files.
 */
export async function runMigrations(
  connection: mysql.Connection,
  migrationDir?: string
): Promise<void> {
  const dir = migrationDir || path.join(__dirname);
  console.log(`Running database migrations from: ${dir}`);

  await ensureSchemaVersionsTable(connection);
  const applied = await getAppliedVersions(connection);

  // Read SQL migration files from the directory (e.g. 001_init.sql)
  const files = fs.readdirSync(dir)
    .filter(file => file.endsWith('.sql') && /^\d+(_\w+)?\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const versionMatch = file.match(/^(\d+)/);
    if (!versionMatch) continue;
    const version = parseInt(versionMatch[1]!, 10);

    if (applied.has(version)) {
      console.log(`Migration ${file} already applied. Skipping.`);
      continue;
    }

    console.log(`Applying migration ${file}...`);
    const filePath = path.join(dir, file);
    
    // We run the migration in a local transaction
    await connection.beginTransaction();
    try {
      await executeSqlFile(connection, filePath);
      await recordAppliedVersion(connection, version, `Applied migration ${file}`);
      await connection.commit();
      console.log(`Migration ${file} applied successfully.`);
    } catch (err) {
      await connection.rollback();
      console.error(`Migration ${file} failed. Rolled back.`);
      throw err;
    }
  }
}
