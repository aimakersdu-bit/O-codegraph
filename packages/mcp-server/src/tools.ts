import { ToolDefinition } from './types';

const repoProperty = {
  type: 'string',
  description: 'Repository identifier (e.g., "org/project")',
};

const branchProperty = {
  type: 'string',
  description: 'Branch name (e.g., "main")',
};

const versionIdProperty = {
  type: 'string',
  description: 'Optional: specify the version ID. If omitted, uses the current active version.',
};

export const tools: ToolDefinition[] = [
  {
    name: 'codegraph_search',
    description: 'Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead to get the actual source / understand an area in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
        query: {
          type: 'string',
          description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
        },
      },
      required: ['repo', 'branch', 'query'],
    },
  },
  {
    name: 'codegraph_callers',
    description: 'List functions that call <symbol>. For the full flow, use codegraph_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callers for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
        },
      },
      required: ['repo', 'branch', 'symbol'],
    },
  },
  {
    name: 'codegraph_callees',
    description: 'List functions that <symbol> calls. For the full flow, use codegraph_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callees for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
        },
      },
      required: ['repo', 'branch', 'symbol'],
    },
  },
  {
    name: 'codegraph_impact',
    description: 'List symbols affected by changing <symbol>. Use before a refactor.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
        symbol: {
          type: 'string',
          description: 'Name of the symbol to analyze impact for',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
        },
      },
      required: ['repo', 'branch', 'symbol'],
    },
  },
  {
    name: 'codegraph_node',
    description: 'SECONDARY (after codegraph_explore): get ONE symbol in full — its location, signature, callers/callees trail, and verbatim body (includeCode=true).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
        symbol: {
          type: 'string',
          description: 'Name of the symbol to get details for',
        },
        includeCode: {
          type: 'boolean',
          description: 'Include full source code (default: false to minimize context)',
        },
        file: {
          type: 'string',
          description: 'Optional: disambiguate an overloaded name to the definition in this file (path or basename).',
        },
        line: {
          type: 'number',
          description: 'Optional: disambiguate to the definition at/around this line.',
        },
      },
      required: ['repo', 'branch', 'symbol'],
    },
  },
  {
    name: 'codegraph_explore',
    description: 'PRIMARY TOOL — call FIRST for almost any question: how does X work, architecture, a bug, where/what is X, or surveying an area. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
        query: {
          type: 'string',
          description: 'Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager").',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
        },
      },
      required: ['repo', 'branch', 'query'],
    },
  },
  {
    name: 'codegraph_status',
    description: 'Index health check (files / nodes / edges). Skip unless debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
      },
      required: ['repo', 'branch'],
    },
  },
  {
    name: 'codegraph_files',
    description: 'Indexed file tree with language + symbol counts. Faster than Glob for project layout.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
        version_id: versionIdProperty,
        path: {
          type: 'string',
          description: 'Filter to files under this directory path (e.g., "src/components"). Returns all files if not specified.',
        },
        pattern: {
          type: 'string',
          description: 'Filter files matching this glob pattern (e.g., "*.tsx", "**/*.test.ts")',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language)',
          enum: ['tree', 'flat', 'grouped'],
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show (default: unlimited)',
        },
      },
      required: ['repo', 'branch'],
    },
  },
  {
    name: 'codegraph_versions',
    description: 'List the available versions for the repository and branch (up to recent 7 versions).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        branch: branchProperty,
      },
      required: ['repo', 'branch'],
    },
  },
];
