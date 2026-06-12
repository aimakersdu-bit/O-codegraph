import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MysqlDatabaseImpl } from '@codegraph/shared';
import { tools } from './tools';
import { ToolHandler } from './tool-handler';
import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'root',
  database: process.env.MYSQL_DATABASE || 'codegraph',
  connectionLimit: parseInt(process.env.MYSQL_POOL_SIZE || '10', 10),
};

console.error('[MCP Server] Initializing MySQL connection pool...');
const db = new MysqlDatabaseImpl(dbConfig);
const handler = new ToolHandler(db);

const server = new Server(
  {
    name: 'codegraph-central-mcp',
    version: '0.9.9',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.error(`[MCP Server] Call tool request: ${name}`, args);
  const result = await handler.execute(name, args || {});
  return result as any;
});

async function run() {
  const mode = process.env.MCP_MODE || 'stdio';

  if (mode === 'sse') {
    const app = express();
    app.use(cors());
    const port = parseInt(process.env.MCP_PORT || '3001', 10);

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
  } else {
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
  console.error('[MCP Server] Closing MySQL pool...');
  await db.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
