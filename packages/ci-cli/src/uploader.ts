import { Node, Edge, FileRecord } from '@colbymchenry/codegraph';

export interface IngestionPayload {
  repo: string;
  branch: string;
  nodes: Array<Node & { sourceCode?: string }>;
  edges: Edge[];
  files: FileRecord[];
  metadata?: Record<string, string>;
}

export async function uploadPayload(
  ingestionUrl: string,
  apiKey: string,
  payload: IngestionPayload
): Promise<string> {
  const url = `${ingestionUrl.replace(/\/$/, '')}/api/v1/ingest`;
  
  console.log(`[Uploader] Uploading ${payload.nodes.length} nodes, ${payload.edges.length} edges, ${payload.files.length} files to ${url}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upload failed (${response.status} ${response.statusText}): ${errorText}`);
  }

  const result = (await response.json()) as { success: boolean; versionId: string };
  if (!result.success || !result.versionId) {
    throw new Error(`Invalid response from ingestion server: ${JSON.stringify(result)}`);
  }

  console.log(`[Uploader] Upload successful. Version ID: ${result.versionId}`);
  return result.versionId;
}
