import { describe, expect, it, vi } from 'vitest';
import { listApps } from './apps.ts';
import { AscApiError, createClient } from './client.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function app(id: string, name: string, bundleId: string) {
  return { type: 'apps', id, attributes: { name, bundleId } };
}

describe('listApps', () => {
  it('すべてのページをたどり、アプリの名前・バンドル ID・Apple ID を返す', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [app('1000000001', 'hikeshi', 'com.ihideck.hikeshi')],
          links: { next: 'https://api.appstoreconnect.apple.com/v1/apps?cursor=AQ' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: [app('1000000002', 'とれろぐ', 'com.ihideck.machosterone')],
          links: {},
        }),
      );

    const apps = await listApps(createClient(() => 'TOKEN', fetchFn));

    expect(apps).toEqual([
      { appleId: '1000000001', name: 'hikeshi', bundleId: 'com.ihideck.hikeshi' },
      { appleId: '1000000002', name: 'とれろぐ', bundleId: 'com.ihideck.machosterone' },
    ]);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    const firstUrl = new URL(String(url));
    expect(firstUrl.pathname).toBe('/v1/apps');
    expect(firstUrl.searchParams.get('fields[apps]')).toBe('name,bundleId');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer TOKEN');
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      'https://api.appstoreconnect.apple.com/v1/apps?cursor=AQ',
    );
  });

  it('次のページの URL が App Store Connect API でなければ、トークンを送らずに止める', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(200, {
        data: [],
        links: { next: 'https://example.com/v1/apps?cursor=AQ' },
      }),
    );

    await expect(listApps(createClient(() => 'TOKEN', fetchFn))).rejects.toThrow(
      'https://example.com',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('エラーの応答は、状態のコードと、Apple のエラーと、直し方を返す', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(401, {
        errors: [
          {
            status: '401',
            code: 'NOT_AUTHORIZED',
            title: 'Authentication credentials are missing or invalid.',
            detail: 'Provide a properly configured and signed bearer token.',
          },
        ],
      }),
    );

    const result = listApps(createClient(() => 'TOKEN', fetchFn));

    await expect(result).rejects.toBeInstanceOf(AscApiError);
    await expect(result).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/401[\s\S]*Issuer ID[\s\S]*NOT_AUTHORIZED/),
    });
  });
});
