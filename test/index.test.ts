import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type JsonRpcResponse = { id: number; result?: Record<string, unknown>; error?: unknown };

const ENTRY = fileURLToPath(new URL('../plugin/src/index.ts', import.meta.url));
const stops: (() => void)[] = [];

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
});

function startServer(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  stops.push(() => child.kill());
  const waiting = new Map<number, (response: JsonRpcResponse) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line) as JsonRpcResponse;
    waiting.get(response.id)?.(response);
  });
  let nextId = 1;

  return {
    request(method: string, params: object): Promise<JsonRpcResponse> {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve) => waiting.set(id, resolve));
    },
    notify(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
  };
}

describe('MCP サーバー', () => {
  it('設定が無くても起動し、list_apps は設定の直し方を返す', async () => {
    const server = startServer({ HOME: await mkdtemp(join(tmpdir(), 'asc-mcp-')) });

    const initialized = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    expect(initialized.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'asc-mcp' },
    });
    server.notify('notifications/initialized');

    const listed = await server.request('tools/list', {});
    const readOnly = expect.objectContaining({ readOnlyHint: true });
    expect(listed.result?.tools).toEqual([
      expect.objectContaining({ name: 'list_apps', annotations: readOnly }),
      expect.objectContaining({
        name: 'get_release_status',
        annotations: readOnly,
        inputSchema: expect.objectContaining({
          required: ['bundleId'],
          properties: expect.objectContaining({
            platform: expect.objectContaining({ default: 'IOS' }),
          }),
        }),
      }),
      expect.objectContaining({
        name: 'get_localizations',
        annotations: readOnly,
        inputSchema: expect.objectContaining({ required: ['bundleId'] }),
      }),
      expect.objectContaining({
        name: 'ensure_version',
        annotations: expect.objectContaining({ readOnlyHint: false, idempotentHint: true }),
        inputSchema: expect.objectContaining({ required: ['bundleId', 'versionString'] }),
      }),
    ]);

    const called = await server.request('tools/call', { name: 'list_apps', arguments: {} });
    expect(called.result).toMatchObject({
      isError: true,
      content: [
        { type: 'text', text: expect.stringContaining('/plugin configure asc-mcp@asc-mcp') },
      ],
    });
  });
});
