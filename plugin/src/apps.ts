import { z } from 'zod';
import type { AscClient } from './client.ts';

const App = z.object({
  id: z.string(),
  attributes: z.object({ name: z.string(), bundleId: z.string() }),
});

export type AppSummary = { appleId: string; name: string; bundleId: string };

export async function listApps(client: AscClient): Promise<AppSummary[]> {
  const apps = await client.getAll(
    '/v1/apps',
    { 'fields[apps]': 'name,bundleId', sort: 'name', limit: '200' },
    App,
  );
  return apps.map((app) => ({
    appleId: app.id,
    name: app.attributes.name,
    bundleId: app.attributes.bundleId,
  }));
}
