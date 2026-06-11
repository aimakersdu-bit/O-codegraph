import {
  Node,
  Edge,
  Subgraph,
  BuildContextOptions,
  TaskContext,
  EdgeKind,
  CodeBlock
} from '@colbymchenry/codegraph';
import { QueryBuilder } from '@codegraph/shared';
import { AsyncGraphTraverser } from './graph';

export class AsyncContextBuilder {
  private traverser: AsyncGraphTraverser;

  constructor(
    private queries: QueryBuilder,
    traverser?: AsyncGraphTraverser
  ) {
    this.traverser = traverser || new AsyncGraphTraverser(queries);
  }

  async findRelevantContext(query: string, options: BuildContextOptions = {}): Promise<Subgraph> {
    const opts = {
      searchLimit: 10,
      traversalDepth: 2,
      maxNodes: 100,
      minScore: 0.1,
      ...options,
    };

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];

    // 1. Search for entry points via FTS/LIKE
    let searchResults = await this.queries.searchNodes(query, { limit: opts.searchLimit });

    // 2. Add entry points to roots
    for (const result of searchResults) {
      if (result.node && !nodes.has(result.node.id)) {
        nodes.set(result.node.id, result.node);
        roots.push(result.node.id);
      }
    }

    // 3. Traverse BFS from each entry point
    for (const rootId of roots) {
      const traversalResult = await this.traverser.traverseBFS(rootId, {
        maxDepth: opts.traversalDepth,
        limit: Math.ceil(opts.maxNodes / Math.max(1, roots.length)),
      });

      for (const [id, node] of traversalResult.nodes) {
        if (!nodes.has(id)) {
          nodes.set(id, node);
        }
      }

      for (const edge of traversalResult.edges) {
        const exists = edges.some(
          (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
        );
        if (!exists) {
          edges.push(edge);
        }
      }
    }

    // 4. Recover edges between already-selected nodes
    const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
    const recoveredEdges = await this.queries.findEdgesBetweenNodes(
      [...nodes.keys()],
      recoveryKinds
    );
    const existingKeys = new Set(edges.map((e) => `${e.source}:${e.target}:${e.kind}`));
    for (const edge of recoveredEdges) {
      const key = `${edge.source}:${edge.target}:${edge.kind}`;
      if (!existingKeys.has(key)) {
        edges.push(edge);
        existingKeys.add(key);
      }
    }

    return {
      nodes,
      edges,
      roots,
    };
  }

  async buildContext(query: string, options: BuildContextOptions = {}): Promise<TaskContext> {
    const subgraph = await this.findRelevantContext(query, options);

    // Get entry points
    const entryPoints = subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => n !== undefined);

    // Extract code blocks (directly from DB)
    const codeBlocks: CodeBlock[] = [];
    const priorityNodes: Node[] = [];

    // Add entry points first
    for (const node of entryPoints) {
      if (node.kind === 'function' || node.kind === 'method' || node.kind === 'class') {
        priorityNodes.push(node);
      }
    }

    // Add other functions/methods/classes
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'function' || node.kind === 'method' || node.kind === 'class') {
          priorityNodes.push(node);
        }
      }
    }

    // Load source code from DB for top symbols (max 8 blocks, max 4000 chars each)
    const maxBlocks = options.maxCodeBlocks || 8;
    for (const node of priorityNodes) {
      if (codeBlocks.length >= maxBlocks) break;
      const code = await this.queries.getNodeSourceCode(node.id);
      if (code) {
        codeBlocks.push({
          content: code,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          language: node.language,
          node,
        });
      }
    }

    const relatedFiles = Array.from(
      new Set(Array.from(subgraph.nodes.values()).map((n) => n.filePath))
    ).sort();

    const stats = {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    };

    const summary = `Found ${subgraph.nodes.size} symbols across ${relatedFiles.length} files. Key entry points: ${entryPoints.slice(0, 3).map((n) => n.name).join(', ')}.`;

    return {
      query,
      summary,
      entryPoints,
      subgraph,
      codeBlocks,
      relatedFiles,
      stats,
    };
  }
}
