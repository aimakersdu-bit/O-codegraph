#!/usr/bin/env node

import { Command } from 'commander';
import { extractAndBuildPayload } from './extractor';
import { uploadPayload } from './uploader';

async function main() {
  const program = new Command();

  program
    .name('codegraph-ci')
    .description('CodeGraph CI tool for extraction and central uploading')
    .version('0.9.9')
    .requiredOption('--repo <repo>', 'Repository identifier (e.g., "org/project")')
    .requiredOption('--branch <branch>', 'Branch name (e.g., "main")')
    .requiredOption('--ingestion-url <url>', 'Ingestion service URL (e.g., "http://localhost:3001")')
    .option('--api-key <key>', 'API key for authentication (optional, defaults to CODEGRAPH_API_KEY environment variable)')
    .option('--path <path>', 'Path to the codebase root (optional, defaults to current working directory)', process.cwd())
    .parse(process.argv);

  const options = program.opts();
  const apiKey = options.apiKey || process.env.CODEGRAPH_API_KEY;

  if (!apiKey) {
    console.error('Error: API key is required. Specify either --api-key or the CODEGRAPH_API_KEY environment variable.');
    process.exit(1);
  }

  try {
    const payload = await extractAndBuildPayload(options.path);
    payload.repo = options.repo;
    payload.branch = options.branch;

    const versionId = await uploadPayload(options.ingestionUrl, apiKey, payload);
    console.log(`[CI] Extraction and upload completed successfully. Registered version: ${versionId}`);
  } catch (err: any) {
    console.error('[CI] Ingestion CLI Error:', err.message || err);
    process.exit(1);
  }
}

main();
