import { describe, expect, it, vi } from 'vitest';
import { listApps } from '../plugin/src/apps.ts';
import { AscApiError, createClient } from '../plugin/src/client.ts';

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

  it('契約の同意が切れているときは、ロールでなく、契約への同意を求める', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(403, {
        errors: [
          {
            status: '403',
            code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED',
            title: 'A required agreement is missing or has expired.',
          },
        ],
      }),
    );

    const message = await listApps(createClient(() => 'TOKEN', fetchFn)).catch((error: unknown) =>
      error instanceof Error ? error.message : '',
    );

    expect(message).toContain('契約に同意');
    expect(message).not.toContain('ロール');
  });

  it('接続できないときは、fetch が隠した原因を添えて返す', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND api.appstoreconnect.apple.com'),
      }),
    );

    await expect(listApps(createClient(() => 'TOKEN', fetchFn))).rejects.toThrow(
      /接続できませんでした.*ENOTFOUND/,
    );
  });

  it('応答の形が違うときは、API のパスと、違う所を返す', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ type: 'apps', id: '1000000001', attributes: { bundleId: 'com.ihideck.hikeshi' } }],
      }),
    );

    await expect(listApps(createClient(() => 'TOKEN', fetchFn))).rejects.toThrow(
      /\/v1\/apps[\s\S]*attributes\.name/,
    );
  });
});
