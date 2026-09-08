export interface SourceCodeExtractionConfig {
  maxNodeSourceLines: number;
  maxNodeSourceBytes: number;
  maxFileSourceLines: number;
  maxFileSourceCoverage: number;
}

export const DEFAULT_SOURCE_CODE_EXTRACTION_CONFIG: SourceCodeExtractionConfig = {
  maxNodeSourceLines: 80,
  maxNodeSourceBytes: 8 * 1024,
  maxFileSourceLines: 200,
  maxFileSourceCoverage: 0.3,
};

export function resolveSourceCodeExtractionConfig(overrides: Partial<SourceCodeExtractionConfig> = {}): SourceCodeExtractionConfig {
  return {
    maxNodeSourceLines: resolveNumber('CODEGRAPH_MAX_NODE_SOURCE_LINES', overrides.maxNodeSourceLines, DEFAULT_SOURCE_CODE_EXTRACTION_CONFIG.maxNodeSourceLines),
    maxNodeSourceBytes: resolveNumber('CODEGRAPH_MAX_NODE_SOURCE_BYTES', overrides.maxNodeSourceBytes, DEFAULT_SOURCE_CODE_EXTRACTION_CONFIG.maxNodeSourceBytes),
    maxFileSourceLines: resolveNumber('CODEGRAPH_MAX_FILE_SOURCE_LINES', overrides.maxFileSourceLines, DEFAULT_SOURCE_CODE_EXTRACTION_CONFIG.maxFileSourceLines),
    maxFileSourceCoverage: resolveRatio('CODEGRAPH_MAX_FILE_SOURCE_COVERAGE', overrides.maxFileSourceCoverage, DEFAULT_SOURCE_CODE_EXTRACTION_CONFIG.maxFileSourceCoverage),
  };
}

function resolveNumber(envName: string, override: number | undefined, fallback: number): number {
  const value = override ?? readNumberEnv(envName);
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}

function resolveRatio(envName: string, override: number | undefined, fallback: number): number {
  const value = override ?? readNumberEnv(envName);
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1) {
    return value;
  }
  return fallback;
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
