import { Node, Edge, Subgraph, TraversalOptions, EdgeKind } from '@colbymchenry/codegraph';
import { QueryBuilder } from '@codegraph/shared';

const DEFAULT_OPTIONS: Required<TraversalOptions> = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

export class AsyncGraphTraverser {
  constructor(private queries: QueryBuilder) {}

  async traverseBFS(startId: string, options: TraversalOptions = {}): Promise<Subgraph> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = await this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, edge, depth } = step;

      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);

      if (edge) {
        edges.push(edge);
      }

      if (depth >= opts.maxDepth) {
        continue;
      }

      const adjacentEdges = await this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
      adjacentEdges.sort((a, b) => {
        const priority = (e: Edge) => (e.kind === 'contains' ? 0 : e.kind === 'calls' ? 1 : 2);
        return priority(a) - priority(b);
      });

      const wantIds = adjacentEdges
        .map((e) => (e.source === node.id ? e.target : e.source))
        .filter((id) => !visited.has(id));
      
      const neighborNodes = wantIds.length > 0 ? await this.queries.getNodesByIds(wantIds) : new Map<string, Node>();

      for (const adjEdge of adjacentEdges) {
        const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;
        if (visited.has(nextNodeId)) continue;

        const nextNode = neighborNodes.get(nextNodeId);
        if (!nextNode) continue;

        if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
          continue;
        }

        nodes.set(nextNode.id, nextNode);
        queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
      }
    }

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  async traverseDFS(startId: string, options: TraversalOptions = {}): Promise<Subgraph> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = await this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    await this.dfsRecursive(startNode, 0, opts, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  private async dfsRecursive(
    node: Node,
    depth: number,
    opts: Required<TraversalOptions>,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) {
      return;
    }

    visited.add(node.id);

    const adjacentEdges = await this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
    const wantIds = adjacentEdges
      .map((e) => (e.source === node.id ? e.target : e.source))
      .filter((id) => !visited.has(id));
    
    const neighborNodes = wantIds.length > 0 ? await this.queries.getNodesByIds(wantIds) : new Map<string, Node>();

    for (const edge of adjacentEdges) {
      const nextNodeId = edge.source === node.id ? edge.target : edge.source;
      if (visited.has(nextNodeId)) continue;

      const nextNode = neighborNodes.get(nextNodeId);
      if (!nextNode) continue;

      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
        continue;
      }

      nodes.set(nextNode.id, nextNode);
      edges.push(edge);

      await this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited);
    }
  }

  private async getAdjacentEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds?: EdgeKind[]
  ): Promise<Edge[]> {
    const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;

    if (direction === 'outgoing') {
      return this.queries.getOutgoingEdges(nodeId, kinds);
    } else if (direction === 'incoming') {
      return this.queries.getIncomingEdges(nodeId, kinds);
    } else {
      const [outgoing, incoming] = await Promise.all([
        this.queries.getOutgoingEdges(nodeId, kinds),
        this.queries.getIncomingEdges(nodeId, kinds),
      ]);
      return [...outgoing, ...incoming];
    }
  }

  async getCallers(nodeId: string, maxDepth: number = 1): Promise<Array<{ node: Node; edge: Edge }>> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    await this.getCallersRecursive(nodeId, maxDepth, 0, result, visited);
    return result;
  }

  private async getCallersRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): Promise<void> {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = await this.queries.getIncomingEdges(nodeId, ['calls', 'references', 'imports']);
    if (incomingEdges.length === 0) return;

    const sourceIds = incomingEdges.map((e) => e.source);
    const callerNodes = await this.queries.getNodesByIds(sourceIds);

    for (const edge of incomingEdges) {
      const callerNode = callerNodes.get(edge.source);
      if (callerNode && !visited.has(callerNode.id)) {
        result.push({ node: callerNode, edge });
        await this.getCallersRecursive(callerNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  async getCallees(nodeId: string, maxDepth: number = 1): Promise<Array<{ node: Node; edge: Edge }>> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    await this.getCalleesRecursive(nodeId, maxDepth, 0, result, visited);
    return result;
  }

  private async getCalleesRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): Promise<void> {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = await this.queries.getOutgoingEdges(nodeId, ['calls', 'references', 'imports']);
    if (outgoingEdges.length === 0) return;

    const targetIds = outgoingEdges.map((e) => e.target);
    const calleeNodes = await this.queries.getNodesByIds(targetIds);

    for (const edge of outgoingEdges) {
      const calleeNode = calleeNodes.get(edge.target);
      if (calleeNode && !visited.has(calleeNode.id)) {
        result.push({ node: calleeNode, edge });
        await this.getCalleesRecursive(calleeNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  async getCallGraph(nodeId: string, depth: number = 2): Promise<Subgraph> {
    const focalNode = await this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    nodes.set(focalNode.id, focalNode);

    const [callers, callees] = await Promise.all([
      this.getCallers(nodeId, depth),
      this.getCallees(nodeId, depth),
    ]);

    for (const { node, edge } of callers) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    for (const { node, edge } of callees) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  async getTypeHierarchy(nodeId: string): Promise<Subgraph> {
    const focalNode = await this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    nodes.set(focalNode.id, focalNode);

    await Promise.all([
      this.getTypeAncestors(nodeId, nodes, edges, visited),
      this.getTypeDescendants(nodeId, nodes, edges, visited),
    ]);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private async getTypeAncestors(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = await this.queries.getOutgoingEdges(nodeId, ['extends', 'implements']);
    if (outgoingEdges.length === 0) return;
    const parents = await this.queries.getNodesByIds(outgoingEdges.map((e) => e.target));

    for (const edge of outgoingEdges) {
      const parentNode = parents.get(edge.target);
      if (parentNode && !nodes.has(parentNode.id)) {
        nodes.set(parentNode.id, parentNode);
        edges.push(edge);
        await this.getTypeAncestors(parentNode.id, nodes, edges, visited);
      }
    }
  }

  private async getTypeDescendants(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = await this.queries.getIncomingEdges(nodeId, ['extends', 'implements']);
    if (incomingEdges.length === 0) return;
    const children = await this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const childNode = children.get(edge.source);
      if (childNode && !nodes.has(childNode.id)) {
        nodes.set(childNode.id, childNode);
        edges.push(edge);
        await this.getTypeDescendants(childNode.id, nodes, edges, visited);
      }
    }
  }

  async getImpactRadius(nodeId: string, maxDepth: number = 3): Promise<Subgraph> {
    const focalNode = await this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    nodes.set(focalNode.id, focalNode);

    await this.getImpactRecursive(nodeId, maxDepth, 0, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private async getImpactRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const focalNode = await this.queries.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set(['class', 'interface', 'struct', 'trait', 'protocol', 'module', 'enum']);
      if (containerKinds.has(focalNode.kind)) {
        const containsEdges = await this.queries.getOutgoingEdges(nodeId, ['contains']);
        if (containsEdges.length > 0) {
          const children = await this.queries.getNodesByIds(containsEdges.map((e) => e.target));
          for (const edge of containsEdges) {
            const childNode = children.get(edge.target);
            if (childNode && !visited.has(childNode.id)) {
              nodes.set(childNode.id, childNode);
              edges.push(edge);
              await this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
            }
          }
        }
      }
    }

    const incomingEdges = await this.queries.getIncomingEdges(nodeId);
    if (incomingEdges.length === 0) return;
    const sources = await this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode && !nodes.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
        edges.push(edge);
        await this.getImpactRecursive(sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
      }
    }
  }

  async getAncestors(nodeId: string): Promise<Node[]> {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      const containingEdges = await this.queries.getIncomingEdges(currentId, ['contains']);
      const firstEdge = containingEdges[0];
      if (!firstEdge) {
        break;
      }

      const parentNode = await this.queries.getNodeById(firstEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  async getChildren(nodeId: string): Promise<Node[]> {
    const containsEdges = await this.queries.getOutgoingEdges(nodeId, ['contains']);
    if (containsEdges.length === 0) return [];

    const childNodes = await this.queries.getNodesByIds(containsEdges.map((e) => e.target));
    const children: Node[] = [];
    for (const edge of containsEdges) {
      const childNode = childNodes.get(edge.target);
      if (childNode) children.push(childNode);
    }
    return children;
  }
}
