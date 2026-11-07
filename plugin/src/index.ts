import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import packageJson from '../package.json' with { type: 'json' };
import { listApps } from './apps.ts';
import { createTokenSource, loadCredentials } from './auth.ts';
import { createClient, type AscClient } from './client.ts';

let client: AscClient | undefined;

// 鍵は、ツールが初めて呼ばれたときに読む。鍵のファイルを置く前でもサーバーは起動し、ツールが置き場所を返す
async function getClient(): Promise<AscClient> {
  client ??= createClient(createTokenSource(await loadCredentials(process.env)));
  return client;
}

const server = new McpServer({ name: 'asc-mcp', version: packageJson.version });

server.registerTool(
  'list_apps',
  {
    title: 'アプリの一覧',
    description: 'App Store Connect にあるアプリの、名前・バンドル ID・Apple ID を返す。',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const apps = await listApps(await getClient());
    return { content: [{ type: 'text', text: JSON.stringify({ apps }, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
