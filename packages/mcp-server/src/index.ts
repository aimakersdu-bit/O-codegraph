import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MysqlDatabaseImpl } from '@codegraph/shared';
import { tools } from './tools';
import { ToolHandler } from './tool-handler';
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
  const result = await handler.execute(name, args || {});
  return result as any;
});

async function run() {
  const transport = new StdioServerTransport();
  console.error('[MCP Server] Starting stdio transport...');
  await server.connect(transport);
  console.error('[MCP Server] Ready and serving tools!');
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
