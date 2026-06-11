import { MysqlDatabase, QueryBuilder, QueryContext } from '@codegraph/shared';
import { formatContextAsMarkdown } from '@colbymchenry/codegraph/dist/context/formatter';
import { AsyncGraphTraverser } from './graph';
import { AsyncContextBuilder } from './context';
import { ToolResult } from './types';
import { minimatch } from 'minimatch';

export class ToolHandler {
  constructor(private db: MysqlDatabase) {}

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private async getContext(args: Record<string, any>): Promise<QueryContext> {
    const repo = args.repo;
    const branch = args.branch;
    const versionId = args.version_id;

    if (!repo || !branch) {
      throw new Error('Missing repo or branch parameter');
    }

    return QueryBuilder.resolveContext(this.db, repo, branch, versionId);
  }

  async execute(name: string, args: Record<string, any>): Promise<ToolResult> {
    try {
      const ctx = await this.getContext(args);
      const qb = new QueryBuilder(this.db, ctx);
      const traverser = new AsyncGraphTraverser(qb);
      const contextBuilder = new AsyncContextBuilder(qb, traverser);

      switch (name) {
        case 'codegraph_search':
          return await this.handleSearch(qb, args);
        case 'codegraph_callers':
          return await this.handleCallers(qb, traverser, args);
        case 'codegraph_callees':
          return await this.handleCallees(qb, traverser, args);
        case 'codegraph_impact':
          return await this.handleImpact(qb, traverser, args);
        case 'codegraph_node':
          return await this.handleNode(qb, traverser, args);
        case 'codegraph_explore':
          return await this.handleExplore(contextBuilder, args);
        case 'codegraph_status':
          return await this.handleStatus(qb);
        case 'codegraph_files':
          return await this.handleFiles(qb, args);
        case 'codegraph_versions':
          return await this.handleVersions(qb);
        default:
          return this.errorResult(`Unknown tool: ${name}`);
      }
    } catch (err: any) {
      console.error(`[ToolHandler] Error running tool ${name}:`, err);
      return this.errorResult(err.message || String(err));
    }
  }

  private async handleSearch(qb: QueryBuilder, args: Record<string, any>): Promise<ToolResult> {
    const query = args.query;
    const kind = args.kind;
    const limit = args.limit || 10;

    const results = await qb.searchNodes(query, {
      limit,
      kinds: kind ? [kind] : undefined,
    });

    if (results.length === 0) {
      return this.textResult(`No symbols found matching "${query}"`);
    }

    const lines = results.map(
      (r) => `- **${r.node.name}** (${r.node.kind}) - ${r.node.filePath}:${r.node.startLine} [score: ${r.score.toFixed(1)}]`
    );

    return this.textResult(`### Search Results\n\n${lines.join('\n')}`);
  }

  private async handleCallers(
    qb: QueryBuilder,
    traverser: AsyncGraphTraverser,
    args: Record<string, any>
  ): Promise<ToolResult> {
    const symbol = args.symbol;
    const limit = args.limit || 20;

    const nodes = await qb.getNodesByName(symbol);
    if (nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found.`);
    }

    const startNode = nodes[0]!;
    const callers = await traverser.getCallers(startNode.id, 1);

    if (callers.length === 0) {
      return this.textResult(`No callers found for "${symbol}"`);
    }

    const lines = callers
      .slice(0, limit)
      .map((c) => `- **${c.node.name}** (${c.node.kind}) in ${c.node.filePath}:${c.node.startLine}`);

    return this.textResult(`### Callers of ${symbol}\n\n${lines.join('\n')}`);
  }

  private async handleCallees(
    qb: QueryBuilder,
    traverser: AsyncGraphTraverser,
    args: Record<string, any>
  ): Promise<ToolResult> {
    const symbol = args.symbol;
    const limit = args.limit || 20;

    const nodes = await qb.getNodesByName(symbol);
    if (nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found.`);
    }

    const startNode = nodes[0]!;
    const callees = await traverser.getCallees(startNode.id, 1);

    if (callees.length === 0) {
      return this.textResult(`No callees found for "${symbol}"`);
    }

    const lines = callees
      .slice(0, limit)
      .map((c) => `- **${c.node.name}** (${c.node.kind}) in ${c.node.filePath}:${c.node.startLine}`);

    return this.textResult(`### Callees of ${symbol}\n\n${lines.join('\n')}`);
  }

  private async handleImpact(
    qb: QueryBuilder,
    traverser: AsyncGraphTraverser,
    args: Record<string, any>
  ): Promise<ToolResult> {
    const symbol = args.symbol;
    const depth = args.depth || 2;

    const nodes = await qb.getNodesByName(symbol);
    if (nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found.`);
    }

    const startNode = nodes[0]!;
    const subgraph = await traverser.getImpactRadius(startNode.id, depth);

    const lines = Array.from(subgraph.nodes.values())
      .filter((n) => n.id !== startNode.id)
      .map((n) => `- **${n.name}** (${n.kind}) in ${n.filePath}:${n.startLine}`);

    if (lines.length === 0) {
      return this.textResult(`No impact dependencies found for "${symbol}" at depth ${depth}.`);
    }

    return this.textResult(`### Impact Radius of ${symbol} (depth ${depth})\n\n${lines.join('\n')}`);
  }

  private async handleNode(
    qb: QueryBuilder,
    traverser: AsyncGraphTraverser,
    args: Record<string, any>
  ): Promise<ToolResult> {
    const symbol = args.symbol;
    const includeCode = args.includeCode || false;
    const file = args.file;
    const line = args.line;

    let nodes = await qb.getNodesByName(symbol);
    if (nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found.`);
    }

    // Filter by file/line if provided
    if (file) {
      nodes = nodes.filter((n) => n.filePath.endsWith(file));
    }
    if (line !== undefined) {
      nodes = nodes.sort((a, b) => Math.abs(a.startLine - line) - Math.abs(b.startLine - line));
    }

    const node = nodes[0]!;
    let output = `## Symbol: ${node.name}\n` +
      `- **Kind:** ${node.kind}\n` +
      `- **File:** ${node.filePath}:${node.startLine}\n` +
      `- **Language:** ${node.language}\n`;

    if (node.signature) {
      output += `- **Signature:** \`${node.signature}\`\n`;
    }
    if (node.docstring) {
      output += `\n### Docstring\n${node.docstring}\n`;
    }

    const [callers, callees] = await Promise.all([
      traverser.getCallers(node.id, 1),
      traverser.getCallees(node.id, 1),
    ]);

    if (callers.length > 0) {
      output += `\n### Callers\n` + callers.map((c) => `- ${c.node.name} (${c.node.filePath}:${c.node.startLine})`).join('\n') + '\n';
    }
    if (callees.length > 0) {
      output += `\n### Callees\n` + callees.map((c) => `- ${c.node.name} (${c.node.filePath}:${c.node.startLine})`).join('\n') + '\n';
    }

    if (includeCode) {
      const code = await qb.getNodeSourceCode(node.id);
      if (code) {
        output += `\n### Verbatim Source Code\n\`\`\`${node.language}\n${code}\n\`\`\`\n`;
      }
    }

    return this.textResult(output);
  }

  private async handleExplore(
    contextBuilder: AsyncContextBuilder,
    args: Record<string, any>
  ): Promise<ToolResult> {
    const query = args.query;
    const maxFiles = args.maxFiles || 12;
    const context = await contextBuilder.buildContext(query, { maxCodeBlocks: maxFiles });
    const formatted = formatContextAsMarkdown(context);

    return this.textResult(formatted);
  }

  private async handleStatus(qb: QueryBuilder): Promise<ToolResult> {
    const stats = await qb.getStats();

    const lines = [
      `### CodeGraph Centralized Server Status`,
      `- **Total Nodes:** ${stats.nodeCount}`,
      `- **Total Edges:** ${stats.edgeCount}`,
      `- **Total Files:** ${stats.fileCount}`,
      `\n#### Files by Language:`,
      ...Object.entries(stats.filesByLanguage).map(([lang, count]) => `  - **${lang}:** ${count}`),
      `\n#### Symbols by Kind:`,
      ...Object.entries(stats.nodesByKind).map(([kind, count]) => `  - **${kind}:** ${count}`),
    ];

    return this.textResult(lines.join('\n'));
  }

  private async handleFiles(qb: QueryBuilder, args: Record<string, any>): Promise<ToolResult> {
    const filterPath = args.path;
    const pattern = args.pattern;
    const format = args.format || 'tree';

    let files = await qb.getAllFiles();

    // Filter by path
    if (filterPath) {
      const normalFilter = filterPath.replace(/^\.\/?/, '').replace(/\/$/, '');
      files = files.filter((f) => f.path.startsWith(normalFilter));
    }

    // Filter by glob pattern
    if (pattern) {
      files = files.filter((f) => minimatch(f.path, pattern, { dot: true }));
    }

    if (files.length === 0) {
      return this.textResult('No files found matching filters.');
    }

    if (format === 'flat') {
      const lines = files.map((f) => `- ${f.path} (${f.language}, size: ${f.size}B, symbols: ${f.nodeCount})`);
      return this.textResult(`### Files List\n\n${lines.join('\n')}`);
    }

    // Default: tree format
    const lines = ['### Files Tree'];
    const buildTree = (filePaths: string[]) => {
      const root: any = {};
      for (const fp of filePaths) {
        const parts = fp.split('/');
        let current = root;
        for (const part of parts) {
          if (!current[part]) current[part] = {};
          current = current[part];
        }
      }
      return root;
    };

    const tree = buildTree(files.map((f) => f.path));

    const printTree = (node: any, prefix: string) => {
      const keys = Object.keys(node).sort();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const isLast = i === keys.length - 1;
        const sub = node[key];
        const hasChildren = Object.keys(sub).length > 0;
        lines.push(`${prefix}${isLast ? '└── ' : '├── '}${key}`);
        if (hasChildren) {
          printTree(sub, prefix + (isLast ? '    ' : '│   '));
        }
      }
    };

    printTree(tree, '');
    return this.textResult(lines.join('\n'));
  }

  private async handleVersions(qb: QueryBuilder): Promise<ToolResult> {
    const versions = await qb.listVersions();
    if (versions.length === 0) {
      return this.textResult('No versions recorded for this project.');
    }

    const lines = versions.map(
      (v) => `- **Version ID:** \`${v.versionId}\` | **Status:** ${v.status} | **Created:** ${new Date(v.createdAt).toLocaleString()}`
    );

    return this.textResult(`### Available Versions (Max 7)\n\n${lines.join('\n')}`);
  }
}
