import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  SearchOptions,
  SearchResult,
  GraphStats,
  NodeKind,
  EdgeKind,
  Language,
} from '@colbymchenry/codegraph';
import { parseQuery, boundedEditDistance } from '@colbymchenry/codegraph/dist/search/query-parser';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '@colbymchenry/codegraph/dist/search/query-utils';
import { DatabaseLike, QueryContext } from './types';

// Helper to safely parse JSON columns
function parseJsonColumn(val: any): any {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return undefined;
    }
  }
  return val;
}

// Map database row to Node
function rowToNode(row: any): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: parseJsonColumn(row.decorators),
    typeParameters: parseJsonColumn(row.type_parameters),
    updatedAt: Number(row.updated_at),
  };
}

// Map database row to Edge
function rowToEdge(row: any): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: parseJsonColumn(row.metadata),
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

// Map database row to FileRecord
function rowToFileRecord(row: any): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: Number(row.modified_at),
    indexedAt: Number(row.indexed_at),
    nodeCount: row.node_count,
    errors: parseJsonColumn(row.errors),
  };
}

// Map database row to UnresolvedReference
function rowToUnresolvedRef(row: any): UnresolvedReference {
  return {
    fromNodeId: row.from_node_id,
    referenceName: row.reference_name,
    referenceKind: row.reference_kind as EdgeKind,
    line: row.line,
    column: row.col,
    filePath: row.file_path,
    language: row.language as Language,
    candidates: parseJsonColumn(row.candidates),
  };
}

export class QueryBuilder {
  constructor(
    private db: DatabaseLike,
    private ctx: QueryContext
  ) {}

  private nodeUpsertSql(): string {
    const conflict = `ON CONFLICT(repo, version, version_id, id) DO UPDATE SET
        kind=excluded.kind, name=excluded.name, qualified_name=excluded.qualified_name,
        file_path=excluded.file_path, language=excluded.language, start_line=excluded.start_line,
        end_line=excluded.end_line, start_column=excluded.start_column, end_column=excluded.end_column,
        docstring=excluded.docstring, signature=excluded.signature, source_code=excluded.source_code,
        visibility=excluded.visibility, is_exported=excluded.is_exported, is_async=excluded.is_async,
        is_static=excluded.is_static, is_abstract=excluded.is_abstract, decorators=excluded.decorators,
        type_parameters=excluded.type_parameters, updated_at=excluded.updated_at`;
    return `INSERT INTO nodes (
      id, repo, version, version_id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, docstring, signature, source_code, visibility,
      is_exported, is_async, is_static, is_abstract, decorators, type_parameters, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${conflict}`;
  }

  /**
   * Resolves the QueryContext for a given repo and version.
   * If versionId is provided, validates that it exists and is not deleting.
   * If versionId is omitted, retrieves the active version.
   */
  static async resolveContext(
    db: DatabaseLike,
    repo: string,
    version: string,
    versionId?: string
  ): Promise<QueryContext> {
    if (versionId) {
      const rows = await db.query(
        'SELECT version_id FROM version_history WHERE repo=? AND version=? AND version_id=? AND status != ?',
        [repo, version, versionId, 'deleting']
      );
      const row = rows[0];
      if (!row) {
        throw new Error(`Version ${versionId} not found or being deleted`);
      }
      return { repo, version, versionId };
    }

    const rows = await db.query(
      'SELECT version_id FROM active_versions WHERE repo=? AND version=?',
      [repo, version]
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`No active version for ${repo}@${version}`);
    }
    return { repo, version, versionId: row.version_id };
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  async insertNode(node: Node, sourceCode?: string): Promise<void> {
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    const sql = this.nodeUpsertSql();

    const params = [
      node.id,
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      node.kind,
      node.name,
      node.qualifiedName ?? node.name,
      node.filePath,
      node.language,
      node.startLine ?? 0,
      node.endLine ?? 0,
      node.startColumn ?? 0,
      node.endColumn ?? 0,
      node.docstring ?? null,
      node.signature ?? null,
      sourceCode ?? null, // Embed full source code snippet
      node.visibility ?? null,
      node.isExported ? 1 : 0,
      node.isAsync ? 1 : 0,
      node.isStatic ? 1 : 0,
      node.isAbstract ? 1 : 0,
      node.decorators ? JSON.stringify(node.decorators) : null,
      node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      node.updatedAt ?? Date.now(),
    ];

    await this.db.execute(sql, params);
  }

  async insertNodes(nodes: Array<Node & { sourceCode?: string }>, nodeSourceCodes?: Map<string, string>): Promise<void> {
    await this.db.transaction(async (conn) => {
      for (const node of nodes) {
        const sourceCode = nodeSourceCodes?.get(node.id);
        const sql = this.nodeUpsertSql();
        const params = [
          node.id,
          this.ctx.repo,
          this.ctx.version,
          this.ctx.versionId,
          node.kind,
          node.name,
          node.qualifiedName ?? node.name,
          node.filePath,
          node.language,
          node.startLine ?? 0,
          node.endLine ?? 0,
          node.startColumn ?? 0,
          node.endColumn ?? 0,
          node.docstring ?? null,
          node.signature ?? null,
          sourceCode ?? node.sourceCode ?? null,
          node.visibility ?? null,
          node.isExported ? 1 : 0,
          node.isAsync ? 1 : 0,
          node.isStatic ? 1 : 0,
          node.isAbstract ? 1 : 0,
          node.decorators ? JSON.stringify(node.decorators) : null,
          node.typeParameters ? JSON.stringify(node.typeParameters) : null,
          node.updatedAt ?? Date.now(),
        ];
        await conn.execute(sql, params);
      }
    });
  }

  async updateNode(node: Node, sourceCode?: string): Promise<void> {
    const sql = `
      UPDATE nodes SET
        kind = ?, name = ?, qualified_name = ?, file_path = ?, language = ?,
        start_line = ?, end_line = ?, start_column = ?, end_column = ?,
        docstring = ?, signature = ?, source_code = COALESCE(?, source_code), visibility = ?,
        is_exported = ?, is_async = ?, is_static = ?, is_abstract = ?,
        decorators = ?, type_parameters = ?, updated_at = ?
      WHERE repo = ? AND version = ? AND version_id = ? AND id = ?
    `;
    const params = [
      node.kind,
      node.name,
      node.qualifiedName ?? node.name,
      node.filePath,
      node.language,
      node.startLine ?? 0,
      node.endLine ?? 0,
      node.startColumn ?? 0,
      node.endColumn ?? 0,
      node.docstring ?? null,
      node.signature ?? null,
      sourceCode ?? null,
      node.visibility ?? null,
      node.isExported ? 1 : 0,
      node.isAsync ? 1 : 0,
      node.isStatic ? 1 : 0,
      node.isAbstract ? 1 : 0,
      node.decorators ? JSON.stringify(node.decorators) : null,
      node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      node.updatedAt ?? Date.now(),
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      node.id,
    ];
    await this.db.execute(sql, params);
  }

  async deleteNode(id: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, id]
    );
  }

  async deleteNodesByFile(filePath: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND file_path = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, filePath]
    );
  }

  async getNodeById(id: string): Promise<Node | null> {
    const rows = await this.db.query(
      'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, id]
    );
    const row = rows[0];
    return row ? rowToNode(row) : null;
  }

  async getNodesByIds(ids: readonly string[]): Promise<Map<string, Node>> {
    const map = new Map<string, Node>();
    if (ids.length === 0) return map;

    // chunk requests if too long to prevent SQL param limit issues
    const chunkSize = 500;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const sql = `SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND id IN (${placeholders})`;
      const params = [this.ctx.repo, this.ctx.version, this.ctx.versionId, ...chunk];
      const rows = await this.db.query(sql, params);
      for (const row of rows) {
        map.set(row.id, rowToNode(row));
      }
    }
    return map;
  }

  async getNodesByFile(filePath: string): Promise<Node[]> {
    const rows = await this.db.query(
      'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND file_path = ? ORDER BY start_line ASC',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, filePath]
    );
    return rows.map(rowToNode);
  }

  async getDominantFile(): Promise<{ filePath: string; edgeCount: number; nextEdgeCount: number } | null> {
    const sql = `
      SELECT file_path, COUNT(*) as edge_count
      FROM nodes
      JOIN edges ON nodes.id = edges.source AND nodes.repo = edges.repo AND nodes.version = edges.version AND nodes.version_id = edges.version_id
      WHERE nodes.repo = ? AND nodes.version = ? AND nodes.version_id = ?
      GROUP BY file_path
      ORDER BY edge_count DESC
      LIMIT 2
    `;
    const rows = await this.db.query(sql, [this.ctx.repo, this.ctx.version, this.ctx.versionId]);
    if (rows.length === 0) return null;
    return {
      filePath: rows[0].file_path,
      edgeCount: rows[0].edge_count,
      nextEdgeCount: rows[1]?.edge_count ?? 0,
    };
  }

  async getTopRouteFile(): Promise<{ filePath: string; routeCount: number; totalRoutes: number } | null> {
    const sqlTotal = `
      SELECT COUNT(*) as count FROM nodes
      WHERE repo = ? AND version = ? AND version_id = ? AND kind = 'route'
    `;
    const totalRows = await this.db.query(sqlTotal, [this.ctx.repo, this.ctx.version, this.ctx.versionId]);
    const totalRoutes = totalRows[0]?.count ?? 0;
    if (totalRoutes === 0) return null;

    const sqlTop = `
      SELECT file_path, COUNT(*) as route_count
      FROM nodes
      WHERE repo = ? AND version = ? AND version_id = ? AND kind = 'route'
      GROUP BY file_path
      ORDER BY route_count DESC
      LIMIT 1
    `;
    const topRows = await this.db.query(sqlTop, [this.ctx.repo, this.ctx.version, this.ctx.versionId]);
    if (topRows.length === 0) return null;

    return {
      filePath: topRows[0].file_path,
      routeCount: topRows[0].route_count,
      totalRoutes,
    };
  }

  async getRoutingManifest(limit: number = 40): Promise<Array<{
    id: string;
    name: string;
    filePath: string;
    startLine: number;
    controllerName?: string;
    controllerPath?: string;
  }>> {
    const sql = `
      SELECT n.id, n.name, n.file_path, n.start_line,
             target.name as controller_name, target.file_path as controller_path
      FROM nodes n
      LEFT JOIN edges e ON n.id = e.source AND n.repo = e.repo AND n.version = e.version AND n.version_id = e.version_id AND e.kind = 'calls'
      LEFT JOIN nodes target ON e.target = target.id AND e.repo = target.repo AND e.version = target.version AND e.version_id = target.version_id
      WHERE n.repo = ? AND n.version = ? AND n.version_id = ? AND n.kind = 'route'
      ORDER BY n.name ASC
      LIMIT ?
    `;
    const rows = await this.db.query(sql, [this.ctx.repo, this.ctx.version, this.ctx.versionId, limit]);
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      filePath: row.file_path,
      startLine: row.start_line,
      controllerName: row.controller_name ?? undefined,
      controllerPath: row.controller_path ?? undefined,
    }));
  }

  async getNodesByKind(kind: NodeKind): Promise<Node[]> {
    const rows = await this.db.query(
      'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND kind = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, kind]
    );
    return rows.map(rowToNode);
  }

  async getAllNodes(): Promise<Node[]> {
    const rows = await this.db.query(
      'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    return rows.map(rowToNode);
  }

  async getNodesByName(name: string): Promise<Node[]> {
    const rows = await this.db.query(
      'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND name = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, name]
    );
    return rows.map(rowToNode);
  }

  async getNodesByQualifiedNameExact(qualifiedName: string): Promise<Node[]> {
    const rows = await this.db.query(
      'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND qualified_name = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, qualifiedName]
    );
    return rows.map(rowToNode);
  }

  async getNodesByLowerName(lowerName: string): Promise<Node[]> {
    const rows = await this.db.query(
      'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND LOWER(name) = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, lowerName]
    );
    return rows.map(rowToNode);
  }

  // Read the persisted source fragment for a node.
  async getNodeSourceCode(id: string): Promise<string | null> {
    const rows = await this.db.query(
      'SELECT source_code FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, id]
    );
    return rows[0]?.source_code ?? null;
  }

  // List versions available in the snapshot.
  async listVersions(): Promise<Array<{ versionId: string; status: string; createdAt: number }>> {
    const rows = await this.db.query(
      'SELECT version_id, status, created_at FROM version_history WHERE repo = ? AND version = ? AND status != ? ORDER BY created_at DESC LIMIT 7',
      [this.ctx.repo, this.ctx.version, 'deleting']
    );
    return rows.map(row => ({
      versionId: row.version_id,
      status: row.status,
      createdAt: Number(row.created_at),
    }));
  }

  // ===========================================================================
  // Search Operations
  // ===========================================================================

  async searchNodes(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 100, offset = 0 } = options;

    const parsed = parseQuery(query);
    const mergedKinds =
      parsed.kinds.length > 0
        ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
        : options.kinds;
    const mergedLanguages =
      parsed.languages.length > 0
        ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
        : options.languages;
    const pathFilters = parsed.pathFilters;
    const nameFilters = parsed.nameFilters;
    const text = parsed.text;
    const kinds = mergedKinds;
    const languages = mergedLanguages;

    let results: SearchResult[] = [];
    if (text) {
      results = await this.searchNodesFTS(text, { kinds, languages, limit, offset });
    } else {
      results = await this.searchAllByFilters({ kinds, languages, limit: limit * 5 });
    }

    if (results.length === 0 && text.length >= 2) {
      results = await this.searchNodesLike(text, { kinds, languages, limit, offset });
    }

    if (results.length === 0 && text.length >= 3) {
      results = await this.searchNodesFuzzy(text, { kinds, languages, limit });
    }

    if (results.length > 0 && query) {
      const existingIds = new Set(results.map(r => r.node.id));
      const maxFtsScore = Math.max(...results.map(r => r.score));
      const terms = query.split(/\s+/).filter(t => t.length >= 2);
      for (const term of terms) {
        let sql = 'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND name = ?';
        const params: (string | number)[] = [this.ctx.repo, this.ctx.version, this.ctx.versionId, term];
        if (kinds && kinds.length > 0) {
          sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
          params.push(...kinds);
        }
        if (languages && languages.length > 0) {
          sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
          params.push(...languages);
        }
        sql += ' LIMIT 20';
        const rows = await this.db.query(sql, params);
        for (const row of rows) {
          if (!existingIds.has(row.id)) {
            results.push({ node: rowToNode(row), score: maxFtsScore });
            existingIds.add(row.id);
          }
        }
      }
    }

    if (results.length > 0 && (text || query)) {
      const scoringQuery = text || query;
      results = results.map(r => ({
        ...r,
        score: r.score
          + kindBonus(r.node.kind)
          + scorePathRelevance(r.node.filePath, scoringQuery)
          + nameMatchBonus(r.node.name, scoringQuery),
      }));
      results.sort((a, b) => b.score - a.score);
      if (results.length > limit) {
        results = results.slice(0, limit);
      }
    }

    if (pathFilters.length > 0) {
      const lowered = pathFilters.map((p: string) => p.toLowerCase());
      results = results.filter((r) => {
        const fp = r.node.filePath.toLowerCase();
        return lowered.some((p: string) => fp.includes(p));
      });
    }
    if (nameFilters.length > 0) {
      const lowered = nameFilters.map((n: string) => n.toLowerCase());
      results = results.filter((r) => {
        const nm = r.node.name.toLowerCase();
        return lowered.some((n: string) => nm.includes(n));
      });
    }

    return results;
  }

  private async searchAllByFilters(options: {
    kinds?: NodeKind[];
    languages?: Language[];
    limit: number;
  }): Promise<SearchResult[]> {
    const { kinds, languages, limit } = options;
    let sql = 'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ?';
    const params: (string | number)[] = [this.ctx.repo, this.ctx.version, this.ctx.versionId];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    sql += ' ORDER BY name LIMIT ?';
    params.push(limit);
    const rows = await this.db.query(sql, params);
    return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
  }

  private async searchNodesFTS(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    const ftsQuery = query
      .replace(/::/g, ' ')
      .replace(/['"*():^]/g, '')
      .split(/\s+/)
      .filter(term => term.length > 0)
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
      .map(term => `${term}*`)
      .join(' ');

    if (!ftsQuery) {
      return [];
    }

    const ftsLimit = Math.max(limit * 5, 100);
    let sql = `
      SELECT n.*, -bm25(nodes_fts) AS score
      FROM nodes_fts
      JOIN nodes n ON n.id = nodes_fts.node_id
      WHERE nodes_fts MATCH ? AND n.repo = ? AND n.version = ? AND n.version_id = ?
    `;
    const params: (string | number)[] = [ftsQuery, this.ctx.repo, this.ctx.version, this.ctx.versionId];

    if (kinds && kinds.length > 0) {
      sql += ` AND n.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND n.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC LIMIT ? OFFSET ?';
    params.push(ftsLimit, offset);

    try {
      const rows = await this.db.query(sql, params);
      return rows.map((row) => ({
        node: rowToNode(row),
        score: Math.abs(Number(row.score ?? 0)) * 100,
      }));
    } catch (err) {
      console.error('[CodeGraph] FTS query failed:', err);
      return [];
    }
  }

  private async searchNodesLike(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    let sql = `
      SELECT *,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name LIKE ? THEN 0.9
          WHEN name LIKE ? THEN 0.8
          WHEN qualified_name LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE repo = ? AND version = ? AND version_id = ?
        AND (
          name LIKE ? OR
          qualified_name LIKE ? OR
          name LIKE ?
        )
    `;

    const exactMatch = query;
    const startsWith = `${query}%`;
    const contains = `%${query}%`;

    const params: (string | number)[] = [
      exactMatch,
      startsWith,
      contains,
      contains,
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      contains,
      contains,
      startsWith,
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC, LENGTH(name) ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = await this.db.query(sql, params);
    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  private async searchNodesFuzzy(
    text: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit: number }
  ): Promise<SearchResult[]> {
    const { kinds, languages, limit } = options;
    const lowered = text.toLowerCase();
    const maxDist = lowered.length <= 4 ? 1 : 2;

    const allNames = await this.getAllNodeNames();
    const candidates: Array<{ name: string; dist: number }> = [];
    for (const name of allNames) {
      const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
      if (dist <= maxDist) candidates.push({ name, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
    const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const c of cappedCandidates) {
      if (results.length >= limit) break;
      let sql = 'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND name = ?';
      const params: (string | number)[] = [this.ctx.repo, this.ctx.version, this.ctx.versionId, c.name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }
      sql += ' LIMIT 5';
      const rows = await this.db.query(sql, params);
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  async findNodesByExactName(names: string[], options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 100 } = options;
    if (names.length === 0) return [];

    const results: SearchResult[] = [];
    const seen = new Set<string>();

    const placeholders = names.map(() => '?').join(',');
    let sql = `SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ? AND name IN (${placeholders})`;
    const params: (string | number)[] = [this.ctx.repo, this.ctx.version, this.ctx.versionId, ...names];

    const rows = await this.db.query(sql, params);
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      results.push({ node: rowToNode(row), score: 1.0 });
    }

    return results.slice(0, limit);
  }

  async findNodesByNameSubstring(
    parts: string[],
    kinds?: NodeKind[],
    limit: number = 20
  ): Promise<SearchResult[]> {
    if (parts.length === 0) return [];

    let sql = 'SELECT * FROM nodes WHERE repo = ? AND version = ? AND version_id = ?';
    const params: (string | number)[] = [this.ctx.repo, this.ctx.version, this.ctx.versionId];

    for (const part of parts) {
      sql += ' AND name LIKE ?';
      params.push(`%${part}%`);
    }

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    sql += ' ORDER BY LENGTH(name) ASC LIMIT ?';
    params.push(limit);

    const rows = await this.db.query(sql, params);
    return rows.map((row) => ({ node: rowToNode(row), score: 0.8 }));
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  async insertEdge(edge: Edge): Promise<void> {
    const sql = `
      INSERT INTO edges (repo, version, version_id, source, target, kind, metadata, line, col, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      edge.source,
      edge.target,
      edge.kind,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
      edge.line ?? null,
      edge.column ?? null,
      edge.provenance ?? null,
    ];
    await this.db.execute(sql, params);
  }

  async insertEdges(edges: Edge[]): Promise<void> {
    await this.db.transaction(async (conn) => {
      for (const edge of edges) {
        const sql = `
          INSERT INTO edges (repo, version, version_id, source, target, kind, metadata, line, col, provenance)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const params = [
          this.ctx.repo,
          this.ctx.version,
          this.ctx.versionId,
          edge.source,
          edge.target,
          edge.kind,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
          edge.line ?? null,
          edge.column ?? null,
          edge.provenance ?? null,
        ];
        await conn.execute(sql, params);
      }
    });
  }

  async deleteEdgesBySource(sourceId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM edges WHERE repo = ? AND version = ? AND version_id = ? AND source = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, sourceId]
    );
  }

  async getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Promise<Edge[]> {
    let sql = 'SELECT * FROM edges WHERE repo = ? AND version = ? AND version_id = ? AND source = ?';
    const params: (string | number)[] = [this.ctx.repo, this.ctx.version, this.ctx.versionId, sourceId];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (provenance) {
      sql += ' AND provenance = ?';
      params.push(provenance);
    }

    const rows = await this.db.query(sql, params);
    return rows.map(rowToEdge);
  }

  async getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Promise<Edge[]> {
    let sql = 'SELECT * FROM edges WHERE repo = ? AND version = ? AND version_id = ? AND target = ?';
    const params: (string | number)[] = [this.ctx.repo, this.ctx.version, this.ctx.versionId, targetId];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = await this.db.query(sql, params);
    return rows.map(rowToEdge);
  }

  async findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Promise<Edge[]> {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(',');
    let sql = `
      SELECT * FROM edges
      WHERE repo = ? AND version = ? AND version_id = ?
        AND source IN (${placeholders})
        AND target IN (${placeholders})
    `;
    const params: any[] = [
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      ...nodeIds,
      ...nodeIds,
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = await this.db.query(sql, params);
    return rows.map(rowToEdge);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  async upsertFile(file: FileRecord): Promise<void> {
    const sql = `
      INSERT INTO files (
        path, repo, version, version_id, content_hash, language, size, modified_at, indexed_at, node_count, errors
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, version, version_id, path) DO UPDATE SET
        content_hash=excluded.content_hash, language=excluded.language, size=excluded.size,
        modified_at=excluded.modified_at, indexed_at=excluded.indexed_at,
        node_count=excluded.node_count, errors=excluded.errors
    `;
    const params = [
      file.path,
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      file.contentHash,
      file.language,
      file.size,
      file.modifiedAt,
      file.indexedAt,
      file.nodeCount ?? 0,
      file.errors ? JSON.stringify(file.errors) : null,
    ];
    await this.db.execute(sql, params);
  }

  async deleteFile(filePath: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM files WHERE repo = ? AND version = ? AND version_id = ? AND path = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, filePath]
    );
  }

  async getFileByPath(filePath: string): Promise<FileRecord | null> {
    const rows = await this.db.query(
      'SELECT * FROM files WHERE repo = ? AND version = ? AND version_id = ? AND path = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, filePath]
    );
    const row = rows[0];
    return row ? rowToFileRecord(row) : null;
  }

  async getAllFiles(): Promise<FileRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM files WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    return rows.map(rowToFileRecord);
  }

  async getStaleFiles(currentHashes: Map<string, string>): Promise<FileRecord[]> {
    const files = await this.getAllFiles();
    return files.filter((f) => {
      const current = currentHashes.get(f.path);
      return !current || current !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  async insertUnresolvedRef(ref: UnresolvedReference): Promise<void> {
    const sql = `
      INSERT INTO unresolved_refs (
        repo, version, version_id, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      ref.fromNodeId,
      ref.referenceName,
      ref.referenceKind,
      ref.line,
      ref.column,
      ref.candidates ? JSON.stringify(ref.candidates) : null,
      ref.filePath ?? '',
      ref.language ?? 'unknown',
    ];
    await this.db.execute(sql, params);
  }

  async insertUnresolvedRefsBatch(refs: UnresolvedReference[]): Promise<void> {
    await this.db.transaction(async (conn) => {
      for (const ref of refs) {
        const sql = `
          INSERT INTO unresolved_refs (
            repo, version, version_id, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const params = [
          this.ctx.repo,
          this.ctx.version,
          this.ctx.versionId,
          ref.fromNodeId,
          ref.referenceName,
          ref.referenceKind,
          ref.line,
          ref.column,
          ref.candidates ? JSON.stringify(ref.candidates) : null,
          ref.filePath ?? '',
          ref.language ?? 'unknown',
        ];
        await conn.execute(sql, params);
      }
    });
  }

  async deleteUnresolvedByNode(nodeId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM unresolved_refs WHERE repo = ? AND version = ? AND version_id = ? AND from_node_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, nodeId]
    );
  }

  async getUnresolvedByName(name: string): Promise<UnresolvedReference[]> {
    const rows = await this.db.query(
      'SELECT * FROM unresolved_refs WHERE repo = ? AND version = ? AND version_id = ? AND reference_name = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, name]
    );
    return rows.map(rowToUnresolvedRef);
  }

  async getUnresolvedReferences(): Promise<UnresolvedReference[]> {
    const rows = await this.db.query(
      'SELECT * FROM unresolved_refs WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    return rows.map(rowToUnresolvedRef);
  }

  async getUnresolvedReferencesCount(): Promise<number> {
    const rows = await this.db.query(
      'SELECT COUNT(*) as count FROM unresolved_refs WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    return rows[0]?.count ?? 0;
  }

  async getUnresolvedReferencesBatch(offset: number, limit: number): Promise<UnresolvedReference[]> {
    const rows = await this.db.query(
      'SELECT * FROM unresolved_refs WHERE repo = ? AND version = ? AND version_id = ? LIMIT ? OFFSET ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, limit, offset]
    );
    return rows.map(rowToUnresolvedRef);
  }

  async getAllFilePaths(): Promise<string[]> {
    const rows = await this.db.query(
      'SELECT DISTINCT path FROM files WHERE repo = ? AND version = ? AND version_id = ? ORDER BY path ASC',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    return rows.map(row => row.path);
  }

  async getAllNodeNames(): Promise<string[]> {
    const rows = await this.db.query(
      'SELECT DISTINCT name FROM nodes WHERE repo = ? AND version = ? AND version_id = ? ORDER BY name ASC',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    return rows.map(row => row.name);
  }

  async getUnresolvedReferencesByFiles(filePaths: string[]): Promise<UnresolvedReference[]> {
    if (filePaths.length === 0) return [];
    const placeholders = filePaths.map(() => '?').join(',');
    const sql = `
      SELECT * FROM unresolved_refs
      WHERE repo = ? AND version = ? AND version_id = ? AND file_path IN (${placeholders})
    `;
    const params = [this.ctx.repo, this.ctx.version, this.ctx.versionId, ...filePaths];
    const rows = await this.db.query(sql, params);
    return rows.map(rowToUnresolvedRef);
  }

  async clearUnresolvedReferences(): Promise<void> {
    await this.db.execute(
      'DELETE FROM unresolved_refs WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
  }

  async deleteResolvedReferences(fromNodeIds: string[]): Promise<void> {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    const sql = `
      DELETE FROM unresolved_refs
      WHERE repo = ? AND version = ? AND version_id = ? AND from_node_id IN (${placeholders})
    `;
    const params = [this.ctx.repo, this.ctx.version, this.ctx.versionId, ...fromNodeIds];
    await this.db.execute(sql, params);
  }

  async deleteSpecificResolvedReferences(refs: Array<{
    fromNodeId: string;
    referenceName: string;
    referenceKind: string;
  }>): Promise<void> {
    if (refs.length === 0) return;
    await this.db.transaction(async (conn) => {
      for (const ref of refs) {
        const sql = `
          DELETE FROM unresolved_refs
          WHERE repo = ? AND version = ? AND version_id = ?
            AND from_node_id = ? AND reference_name = ? AND reference_kind = ?
        `;
        const params = [
          this.ctx.repo,
          this.ctx.version,
          this.ctx.versionId,
          ref.fromNodeId,
          ref.referenceName,
          ref.referenceKind,
        ];
        await conn.execute(sql, params);
      }
    });
  }

  // ===========================================================================
  // Stats & Metadata
  // ===========================================================================

  async getNodeAndEdgeCount(): Promise<{ nodes: number; edges: number }> {
    const nodeRows = await this.db.query(
      'SELECT COUNT(*) as count FROM nodes WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    const edgeRows = await this.db.query(
      'SELECT COUNT(*) as count FROM edges WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    return {
      nodes: nodeRows[0]?.count ?? 0,
      edges: edgeRows[0]?.count ?? 0,
    };
  }

  async getStats(): Promise<GraphStats> {
    const { nodes, edges } = await this.getNodeAndEdgeCount();
    
    const fileRows = await this.db.query(
      'SELECT COUNT(*) as count FROM files WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    const files = fileRows[0]?.count ?? 0;

    const kindRows = await this.db.query(
      'SELECT kind, COUNT(*) as count FROM nodes WHERE repo = ? AND version = ? AND version_id = ? GROUP BY kind',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    const nodesByKind: Record<string, number> = {};
    for (const row of kindRows) {
      nodesByKind[row.kind] = row.count;
    }

    const edgeKindRows = await this.db.query(
      'SELECT kind, COUNT(*) as count FROM edges WHERE repo = ? AND version = ? AND version_id = ? GROUP BY kind',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    const edgesByKind: Record<string, number> = {};
    for (const row of edgeKindRows) {
      edgesByKind[row.kind] = row.count;
    }

    const languageRows = await this.db.query(
      'SELECT language, COUNT(*) as count FROM files WHERE repo = ? AND version = ? AND version_id = ? GROUP BY language',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    const filesByLanguage: Record<string, number> = {};
    for (const row of languageRows) {
      filesByLanguage[row.language] = row.count;
    }

    return {
      nodeCount: nodes,
      edgeCount: edges,
      fileCount: files,
      nodesByKind: nodesByKind as Record<NodeKind, number>,
      edgesByKind: edgesByKind as Record<EdgeKind, number>,
      filesByLanguage: filesByLanguage as Record<Language, number>,
      dbSizeBytes: 0,
      lastUpdated: Date.now(),
    };
  }

  async getMetadata(key: string): Promise<string | null> {
    const rows = await this.db.query(
      'SELECT value FROM project_metadata WHERE repo = ? AND version = ? AND version_id = ? AND `key` = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId, key]
    );
    return rows[0]?.value ?? null;
  }

  async setMetadata(key: string, value: string): Promise<void> {
    const sql = `
      INSERT INTO project_metadata (repo, version, version_id, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, version, version_id, key) DO UPDATE SET
        value=excluded.value, updated_at=excluded.updated_at
    `;
    const params = [
      this.ctx.repo,
      this.ctx.version,
      this.ctx.versionId,
      key,
      value,
      Date.now(),
    ];
    await this.db.execute(sql, params);
  }

  async getAllMetadata(): Promise<Record<string, string>> {
    const rows = await this.db.query(
      'SELECT `key`, value FROM project_metadata WHERE repo = ? AND version = ? AND version_id = ?',
      [this.ctx.repo, this.ctx.version, this.ctx.versionId]
    );
    const metadata: Record<string, string> = {};
    for (const row of rows) {
      metadata[row.key] = row.value;
    }
    return metadata;
  }
}
