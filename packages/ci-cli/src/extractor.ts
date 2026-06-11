import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '@colbymchenry/codegraph';
import { DatabaseConnection, getDatabasePath } from '@colbymchenry/codegraph';
import { Node, Edge, FileRecord } from '@colbymchenry/codegraph';
import { IngestionPayload } from './uploader';

export async function extractAndBuildPayload(projectRoot: string): Promise<IngestionPayload> {
  const resolvedRoot = path.resolve(projectRoot);
  console.log(`[Extractor] Starting extraction in ${resolvedRoot}...`);

  // 1. Initialize or open CodeGraph
  let codegraph: CodeGraph;
  const alreadyInitialized = CodeGraph.isInitialized(resolvedRoot);
  if (alreadyInitialized) {
    console.log('[Extractor] CodeGraph already initialized. Opening...');
    codegraph = await CodeGraph.open(resolvedRoot);
  } else {
    console.log('[Extractor] CodeGraph not initialized. Initializing...');
    codegraph = await CodeGraph.init(resolvedRoot);
  }

  // 2. Perform full indexing
  console.log('[Extractor] Indexing project files...');
  const indexResult = await codegraph.indexAll({
    onProgress: (progress) => {
      console.log(`[Extractor] Progress: ${progress.phase} - ${progress.current}/${progress.total} ${progress.currentFile || ''}`);
    }
  });

  if (!indexResult.success) {
    codegraph.close();
    throw new Error(`Indexing failed: ${JSON.stringify(indexResult.errors)}`);
  }

  // 3. Connect to SQLite to read tables
  const dbPath = getDatabasePath(resolvedRoot);
  console.log(`[Extractor] Reading extracted graph from local database: ${dbPath}`);
  const dbConn = DatabaseConnection.open(dbPath);
  const sqlite = dbConn.getDb();

  // Helper to read all rows
  const allNodesRaw = sqlite.prepare('SELECT * FROM nodes').all() as any[];
  const allEdgesRaw = sqlite.prepare('SELECT * FROM edges').all() as any[];
  const allFilesRaw = sqlite.prepare('SELECT * FROM files').all() as any[];
  const allMetaRaw = sqlite.prepare('SELECT * FROM project_metadata').all() as any[];

  dbConn.close();
  codegraph.close();

  // 4. Clean up the local .codegraph/ directory if we initialized it
  if (!alreadyInitialized) {
    const cgDir = path.join(resolvedRoot, '.codegraph');
    console.log(`[Extractor] Cleaning up local temporary metadata directory: ${cgDir}`);
    fs.rmSync(cgDir, { recursive: true, force: true });
  }

  // 5. Build Node structures and extract source code slices
  console.log('[Extractor] Reading source code slices for nodes...');
  const fileCache = new Map<string, string[]>();

  const nodes: Array<Node & { sourceCode?: string }> = allNodesRaw.map((row) => {
    let sourceCode: string | undefined;
    const filePath = path.join(resolvedRoot, row.file_path);

    try {
      if (fs.existsSync(filePath)) {
        let lines = fileCache.get(row.file_path);
        if (!lines) {
          const content = fs.readFileSync(filePath, 'utf-8');
          lines = content.split('\n');
          fileCache.set(row.file_path, lines);
        }
        const startIdx = Math.max(0, row.start_line - 1);
        const endIdx = Math.min(lines.length, row.end_line);
        sourceCode = lines.slice(startIdx, endIdx).join('\n');
      }
    } catch (err) {
      console.warn(`[Extractor] Warning: Could not read source code for node ${row.id} from ${row.file_path}:`, err);
    }

    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name,
      filePath: row.file_path,
      language: row.language,
      startLine: row.start_line,
      endLine: row.end_line,
      startColumn: row.start_column,
      endColumn: row.end_column,
      docstring: row.docstring || undefined,
      signature: row.signature || undefined,
      visibility: row.visibility || undefined,
      isExported: row.is_exported === 1,
      isAsync: row.is_async === 1,
      isStatic: row.is_static === 1,
      isAbstract: row.is_abstract === 1,
      decorators: row.decorators ? JSON.parse(row.decorators) : undefined,
      typeParameters: row.type_parameters ? JSON.parse(row.type_parameters) : undefined,
      updatedAt: Number(row.updated_at),
      sourceCode,
    };
  });

  // 6. Build Edges
  const edges: Edge[] = allEdgesRaw.map((row) => ({
    source: row.source,
    target: row.target,
    kind: row.kind,
    line: row.line || undefined,
    column: row.col || undefined,
    provenance: row.provenance || undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  }));

  // 7. Build Files
  const files: FileRecord[] = allFilesRaw.map((row) => ({
    path: row.path,
    contentHash: row.content_hash,
    language: row.language,
    size: row.size,
    modifiedAt: Number(row.modified_at),
    indexedAt: Number(row.indexed_at),
    nodeCount: row.node_count,
    errors: row.errors ? JSON.parse(row.errors) : undefined,
  }));

  // 8. Build Metadata
  const metadata: Record<string, string> = {};
  for (const row of allMetaRaw) {
    metadata[row.key] = row.value;
  }

  return {
    repo: '', // to be set by caller
    branch: '', // to be set by caller
    nodes,
    edges,
    files,
    metadata,
  };
}
