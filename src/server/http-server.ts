/**
 * CodeGraph HTTP API Server
 *
 * A lightweight HTTP server built on Node.js native `http` module (zero
 * external dependencies) that exposes CodeGraph functionality as standard
 * REST-ish JSON endpoints — complementing the MCP (stdio) transport for
 * non-agent consumers (dashboards, scripts, browser tools, CI pipelines).
 *
 * Design constraints:
 * - Shares the same {@link MCPEngine} as the MCP server when running in
 *   dual-protocol mode (`serve --mcp --http`), so there is exactly one
 *   SQLite connection, one file watcher, and one in-memory cache.
 * - All logging goes to `process.stderr` so it never contaminates the
 *   MCP stdio channel when running alongside.
 * - CORS enabled by default (permissive `*`) for browser-based tools.
 *
 * @module server/http-server
 */

import * as http from 'http';
import { MCPEngine } from '../mcp/engine';
import { tools as allToolDefs, getStaticTools } from '../mcp/tools';
import { CodeGraphPackageVersion } from '../mcp/version';

/** Maximum request body size in bytes (1 MB). */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Shortcut route table — maps `/api/<shortcut>` POST endpoints to their
 * canonical `codegraph_<tool>` name so callers don't have to spell out the
 * full MCP tool name.
 */
const SHORTCUT_ROUTES: Record<string, string> = {
  search:  'codegraph_search',
  explore: 'codegraph_explore',
  node:    'codegraph_node',
  callers: 'codegraph_callers',
  callees: 'codegraph_callees',
  impact:  'codegraph_impact',
  files:   'codegraph_files',
  status:  'codegraph_status',
};

export interface HTTPServerOptions {
  /** Port to listen on. Default: 5123. */
  port?: number;
  /** Host/address to bind. Default: '127.0.0.1'. */
  host?: string;
}

/**
 * CodeGraph HTTP API Server.
 *
 * Usage:
 * ```ts
 * const engine = new MCPEngine();
 * await engine.ensureInitialized('/path/to/project');
 * const http = new HTTPServer(engine, { port: 5123 });
 * await http.start();
 * ```
 */
export class HTTPServer {
  private server: http.Server | null = null;
  private engine: MCPEngine;
  private port: number;
  private host: string;

  constructor(engine: MCPEngine, opts: HTTPServerOptions = {}) {
    this.engine = engine;
    this.port = opts.port ?? 5123;
    this.host = opts.host ?? '127.0.0.1';
  }

  /**
   * Start listening. Returns a promise that resolves once the socket is bound.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[CodeGraph HTTP] Unhandled error: ${msg}\n`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      });

      this.server.on('error', (err) => {
        process.stderr.write(`[CodeGraph HTTP] Server error: ${err.message}\n`);
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        process.stderr.write(
          `[CodeGraph HTTP] API server listening on http://${this.host}:${this.port}/api\n`,
        );
        resolve();
      });
    });
  }

  /** Gracefully shut down the HTTP server. */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // ===========================================================================
  // Request Router
  // ===========================================================================

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // ---- CORS preflight ----
    this.setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/'; // strip trailing slashes

    // ---- GET /api — server info ----
    if ((pathname === '/api' || pathname === '/') && req.method === 'GET') {
      return this.sendJson(res, 200, {
        name: 'codegraph',
        version: CodeGraphPackageVersion,
        projectPath: this.engine.getProjectPath(),
        initialized: this.engine.hasDefaultCodeGraph(),
      });
    }

    // ---- GET /api/tools — tool definitions ----
    if (pathname === '/api/tools' && req.method === 'GET') {
      const handler = this.engine.getToolHandler();
      const toolDefs = handler.hasDefaultCodeGraph()
        ? handler.getTools()
        : getStaticTools();
      return this.sendJson(res, 200, { tools: toolDefs });
    }

    // ---- POST /api/tools/:toolName — generic tool execution ----
    const toolExecMatch = pathname.match(/^\/api\/tools\/([a-z_]+)$/);
    if (toolExecMatch && toolExecMatch[1] && req.method === 'POST') {
      const rawName = toolExecMatch[1];
      // Accept both "search" and "codegraph_search"
      const toolName = rawName.startsWith('codegraph_') ? rawName : `codegraph_${rawName}`;
      return this.executeTool(req, res, toolName);
    }

    // ---- POST /api/<shortcut> — shortcut tool execution ----
    const shortcutMatch = pathname.match(/^\/api\/([a-z_]+)$/);
    if (shortcutMatch && shortcutMatch[1] && req.method === 'POST') {
      const key = shortcutMatch[1];
      const toolName = SHORTCUT_ROUTES[key];
      if (toolName) {
        return this.executeTool(req, res, toolName);
      }
    }


    // ---- 404 ----
    return this.sendJson(res, 404, {
      error: 'Not found',
      availableEndpoints: [
        'GET  /api',
        'GET  /api/tools',
        'POST /api/tools/:toolName',
        ...Object.keys(SHORTCUT_ROUTES).map((k) => `POST /api/${k}`),
      ],
    });
  }

  // ===========================================================================
  // Tool Execution
  // ===========================================================================

  private async executeTool(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    toolName: string,
  ): Promise<void> {
    // Verify the tool exists
    const tool = allToolDefs.find((t) => t.name === toolName);
    if (!tool) {
      return this.sendJson(res, 404, {
        error: `Unknown tool: ${toolName}`,
        availableTools: allToolDefs.map((t) => t.name),
      });
    }

    // Ensure engine is initialized — retry lazily the same way the MCP
    // session does, so the first HTTP call can still bootstrap the project.
    if (!this.engine.hasDefaultCodeGraph()) {
      const hint = this.engine.getProjectPath() ?? process.cwd();
      this.engine.retryInitializeSync(hint);
    }

    // Parse JSON body
    let args: Record<string, unknown>;
    try {
      args = await this.readJsonBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.sendJson(res, 400, { error: `Invalid request body: ${msg}` });
    }

    // Execute
    const handler = this.engine.getToolHandler();
    const result = await handler.execute(toolName, args);

    const statusCode = result.isError ? 422 : 200;
    return this.sendJson(res, statusCode, result);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  /**
   * Read and parse the request body as JSON. Enforces a size limit to prevent
   * denial-of-service via oversized payloads. Returns `{}` for empty bodies
   * (GET-style tool calls with no arguments).
   */
  private readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw.length === 0) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new Error('Body must be a JSON object'));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new Error('Malformed JSON'));
        }
      });

      req.on('error', (err) => reject(err));
    });
  }
}
