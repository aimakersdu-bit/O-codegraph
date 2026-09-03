import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools';
import { ToolHandler } from './tool-handler';
import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';

dotenv.config();

console.error('[MCP Server] Using SQLite repository snapshots...');

function createMcpServer() {
  const handler = new ToolHandler();
  const server = new Server(
    {
      name: 'codegraph-central-mcp',
      version: '0.9.9',
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    console.error(`[MCP Server] Call tool request: ${name}`, args);
    const result = await handler.execute(name, args || {}, {
      requestId: extra.requestId,
      progressToken: request.params?._meta?.progressToken,
      sendNotification: async (notification) => {
        await extra.sendNotification(notification as any);
      },
    });
    return result as any;
  });

  return { server, handler };
}

function createApiApp(handler: ToolHandler, modeLabel: string) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get(['/api', '/'], (_req, res) => {
    res.json({
      name: 'codegraph-central-mcp',
      version: '0.9.9',
      mode: modeLabel,
    });
  });

  app.get('/api/tools', (_req, res) => {
    res.json({ tools });
  });

  const SHORTCUT_ROUTES: Record<string, string> = {
    search: 'codegraph_search',
    explore: 'codegraph_explore',
    node: 'codegraph_node',
    callers: 'codegraph_callers',
    callees: 'codegraph_callees',
    impact: 'codegraph_impact',
    files: 'codegraph_files',
    status: 'codegraph_status',
    versions: 'codegraph_versions',
  };

  const executeTool = async (res: express.Response, toolName: string, args: any) => {
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      return res.status(404).json({
        error: `Unknown tool: ${toolName}`,
        availableTools: tools.map((t) => t.name),
      });
    }
    try {
      const result = await handler.execute(toolName, args || {});
      const statusCode = result.isError ? 422 : 200;
      return res.status(statusCode).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Tool execution failed: ${msg}` });
    }
  };

  app.post('/api/tools/:toolName', async (req, res) => {
    const rawName = req.params.toolName;
    const toolName = rawName.startsWith('codegraph_') ? rawName : `codegraph_${rawName}`;
    await executeTool(res, toolName, req.body);
  });

  app.post('/api/:shortcut', async (req, res) => {
    const key = req.params.shortcut;
    const toolName = SHORTCUT_ROUTES[key];
    if (toolName) {
      await executeTool(res, toolName, req.body);
    } else {
      res.status(404).json({ error: `Shortcut route /api/${key} not found` });
    }
  });

  return app;
}

async function run() {
  const mode = process.env.MCP_MODE || 'stdio';

  if (mode === 'sse') {
    const { server, handler } = createMcpServer();
    const app = createApiApp(handler, 'sse');
    const port = parseInt(process.env.MCP_PORT || '3001', 10);

    // ===========================================================================
    // MCP SSE Transports
    // ===========================================================================

    const transports = new Map<string, SSEServerTransport>();

    app.get(['/sse', '/mcp'], async (_req, res) => {
      console.error('[MCP Server] New SSE connection request');
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);

      transport.onclose = () => {
        console.error(`[MCP Server] SSE connection closed for session: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
      };

      await server.connect(transport);
    });

    app.post(['/messages', '/mcp/messages'], async (req, res) => {
      const sessionId = (req.query.sessionId || req.query.session_id || req.headers['mcp-session-id']) as string;
      console.error(`[MCP Server] POST /messages received for session: ${sessionId}`);
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        console.error(`[MCP Server] Session not found: ${sessionId}`);
        res.status(404).send('Session not found');
      }
    });

    app.listen(port, () => {
      console.error(`[MCP Server] SSE transport listening on port ${port}`);
      console.error(`- Connection URL: http://localhost:${port}/sse`);
      console.error(`- Message URL: http://localhost:${port}/messages`);
    });
  } else if (mode === 'streamable-http-stateless') {
    const app = createApiApp(new ToolHandler(), 'streamable-http-stateless');
    const port = parseInt(process.env.MCP_PORT || '3001', 10);
    const mcpPath = '/mcp';

    app.all(mcpPath, async (req, res) => {
      try {
        const { server } = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: false,
        });
        await server.connect(transport);
        await transport.handleRequest(req as any, res as any, req.body);
        res.on('close', () => {
          transport.close().catch(() => undefined);
          server.close().catch(() => undefined);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: msg },
            id: null,
          });
        }
      }
    });

    app.listen(port, () => {
      console.error(`[MCP Server] Streamable HTTP transport listening on port ${port}`);
      console.error(`- MCP URL: http://localhost:${port}/mcp`);
    });
  } else {
    const { server } = createMcpServer();
    const transport = new StdioServerTransport();
    console.error('[MCP Server] Starting stdio transport...');
    await server.connect(transport);
    console.error('[MCP Server] Ready and serving tools!');
  }
}

run().catch((err) => {
  console.error('[MCP Server] Fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = async () => {
    process.exit(0);
  };

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
