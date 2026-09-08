#!/usr/bin/env node

import { Command } from 'commander';
import { isValidExportVersion } from '@codegraph/shared';
import { extractAndBuildPayload } from './extractor';
import { exportPayloadToSqlite } from './sqlite-exporter';
import { SourceCodeExtractionConfig } from './config';

async function main() {
  const program = new Command();

  program
    .name('codegraph-ci')
    .description('CodeGraph CI tool for extraction and SQLite export')
    .version('0.9.9', '-V, --cli-version')
    .requiredOption('--repo <repo>', 'Repository identifier (e.g., "org/project")')
    .requiredOption('--version <version>', 'CodeGraph export version (e.g., "260827.1.0.2233")')
    .option('--output-dir <path>', 'Export directory (defaults to CODEGRAPH_OUTPUT_DIR or ./codegraph-exports)', process.env.CODEGRAPH_OUTPUT_DIR || 'codegraph-exports')
    .option('--path <path>', 'Path to the codebase root (optional, defaults to current working directory)', process.cwd())
    .option('--max-node-source-lines <number>', 'Maximum source lines per node', parseNumberOption)
    .option('--max-node-source-bytes <number>', 'Maximum source bytes per node', parseNumberOption)
    .option('--max-file-source-lines <number>', 'Maximum covered source lines per file', parseNumberOption)
    .option('--max-file-source-coverage <number>', 'Maximum coverage ratio per file (0-1)', parseNumberOption)
    .parse(process.argv);

  const options = program.opts();
  if (!isValidExportVersion(options.version)) {
    console.error('Error: --version must match YYMMDD.major.minor.build, e.g. 260827.1.0.2233');
    process.exit(1);
  }

  try {
    const extractionConfig: Partial<SourceCodeExtractionConfig> = {
      maxNodeSourceLines: options.maxNodeSourceLines,
      maxNodeSourceBytes: options.maxNodeSourceBytes,
      maxFileSourceLines: options.maxFileSourceLines,
      maxFileSourceCoverage: options.maxFileSourceCoverage,
    };
    const payload = await extractAndBuildPayload(options.path, extractionConfig);
    payload.repo = options.repo;
    payload.version = options.version;

    const result = await exportPayloadToSqlite({
      outputDir: options.outputDir,
      payload,
      sourceProjectRoot: options.path,
      codegraphVersion: '0.9.9',
    });
    console.log(`[CI] Extraction and export completed successfully. Wrote ${result.dbPath} (version: ${result.versionId})`);
  } catch (err: any) {
    console.error('[CI] Export CLI Error:', err.message || err);
    process.exit(1);
  }
}

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

main();
