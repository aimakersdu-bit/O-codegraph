import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
  }) as ChildProcessWithoutNullStreams;
}

describe('HTTP Server Integration', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;
  const PORT = 6123;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-http-test-'));
    // Initialize a dummy codegraph project so we have a valid index
    const cg = await CodeGraph.init(tempDir);
    cg.close();
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects --http without --mcp', async () => {
    child = spawnServer(tempDir, ['serve', '--http', '--port', String(PORT)]);
    
    const exitCodePromise = new Promise<number | null>((resolve) => {
      child!.on('exit', (code) => resolve(code));
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const code = await exitCodePromise;
    expect(code).toBe(1);
    expect(stderr).toContain('--http can only be used together with --mcp');
  });

  it('starts HTTP server alongside MCP when --mcp --http is passed', async () => {
    child = spawnServer(tempDir, [
      'serve',
      '--mcp',
      '--http',
      '--port',
      String(PORT),
      '--path',
      tempDir,
    ]);

    // Wait for the HTTP server listening log on stderr
    let output = '';
    const listeningPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for HTTP server to start. Stderr: ' + output)), 10000);
      child!.stderr.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output.includes('API server listening on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await listeningPromise;

    // Test GET /api
    const resInfo = await fetch(`http://127.0.0.1:${PORT}/api`);
    expect(resInfo.status).toBe(200);
    const info = await resInfo.json() as any;
    expect(info.name).toBe('codegraph');
    expect(info.version).toBeDefined();
    expect(info.projectPath).toBeDefined();

    // Test GET /api/tools
    const resTools = await fetch(`http://127.0.0.1:${PORT}/api/tools`);
    expect(resTools.status).toBe(200);
    const toolsData = await resTools.json() as any;
    expect(Array.isArray(toolsData.tools)).toBe(true);
    expect(toolsData.tools.some((t: any) => t.name === 'codegraph_search')).toBe(true);

    // Test POST /api/search
    const resSearch = await fetch(`http://127.0.0.1:${PORT}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(resSearch.status).toBe(200);
    const searchData = await resSearch.json() as any;
    expect(searchData.isError).toBeUndefined();

    // Test CORS preflight (OPTIONS /api/tools)
    const resCors = await fetch(`http://127.0.0.1:${PORT}/api/tools`, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    expect(resCors.status).toBe(204);
    expect(resCors.headers.get('access-control-allow-origin')).toBe('*');
    expect(resCors.headers.get('access-control-allow-methods')).toContain('POST');
  }, 20000);
});
