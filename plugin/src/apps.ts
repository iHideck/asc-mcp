import { z } from 'zod';
import { sparseFields, type AscClient } from './client.ts';

const App = z.object({
  type: z.literal('apps'),
  id: z.string(),
  attributes: z.object({ name: z.string(), bundleId: z.string() }),
});

export type AppSummary = { appleId: string; name: string; bundleId: string };

export async function listApps(client: AscClient): Promise<AppSummary[]> {
  const { data } = await client.getAll(
    '/v1/apps',
    { ...sparseFields(App), sort: 'name', limit: '200' },
    { data: App },
  );
  return data.map(summarize);
}

export async function findApp(client: AscClient, bundleId: string): Promise<AppSummary> {
  const { data } = await client.getAll(
    '/v1/apps',
    { ...sparseFields(App), 'filter[bundleId]': bundleId, limit: '200' },
    { data: App },
  );
  // filter[bundleId] が、バンドル ID の完全な一致で選ぶかは、Apple の文書に書いていない
  const app = data.find((candidate) => candidate.attributes.bundleId === bundleId);
  if (app === undefined) {
    throw new Error(
      `バンドル ID が ${bundleId} のアプリは、App Store Connect にありません。list_apps で、あるアプリを見られます。`,
    );
  }
  return summarize(app);
}

function summarize(app: z.infer<typeof App>): AppSummary {
  return { appleId: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId };
}
