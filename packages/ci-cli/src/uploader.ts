import { Node, Edge, FileRecord } from '@colbymchenry/codegraph';

export interface IngestionPayload {
  repo: string;
  version: string;
  nodes: Array<Node & { sourceCode?: string }>;
  edges: Edge[];
  files: FileRecord[];
  metadata?: Record<string, string>;
}
