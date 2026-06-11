import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractAndBuildPayload } from '../src/extractor';

describe('CI CLI Extraction Integration Tests', () => {
  let tempDir: string;
  let codePath: string;

  beforeAll(() => {
    // Create a temporary project directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ci-test-'));
    
    // Write a dummy TypeScript file
    codePath = path.join(tempDir, 'dummy.ts');
    fs.writeFileSync(
      codePath,
      `export function add(a: number, b: number): number {
  return a + b;
}`
    );
  });

  afterAll(() => {
    // Cleanup temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should successfully index a directory and build payload with source code', async () => {
    const payload = await extractAndBuildPayload(tempDir);

    expect(payload.nodes.length).toBeGreaterThan(0);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].path).toBe('dummy.ts');

    // Find the add function node
    const funcNode = payload.nodes.find((n) => n.name === 'add');
    expect(funcNode).toBeDefined();
    expect(funcNode!.kind).toBe('function');
    expect(funcNode!.sourceCode).toBe(`export function add(a: number, b: number): number {
  return a + b;
}`);

    // Verify local .codegraph/ directory was cleaned up
    const cgDir = path.join(tempDir, '.codegraph');
    expect(fs.existsSync(cgDir)).toBe(false);
  });
});
