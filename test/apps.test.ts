import { describe, expect, it, vi } from 'vitest';
import { findApp, listApps } from '../plugin/src/apps.ts';
import { AscApiError, createClient } from '../plugin/src/client.ts';
import { fakeFetch, jsonResponse, page, requestedUrls, resource } from './fake-api.ts';

function app(id: string, name: string, bundleId: string) {
  return resource('apps', id, { name, bundleId });
}

describe('listApps', () => {
  it('すべてのページをたどり、アプリの名前・バンドル ID・Apple ID を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': [
        page([app('1000000001', 'hikeshi', 'com.ihideck.hikeshi')], {
          next: '/v1/apps?cursor=AQ',
        }),
        page([app('1000000002', 'とれろぐ', 'com.ihideck.machosterone')]),
      ],
    });

    const apps = await listApps(createClient(() => 'TOKEN', fetchFn));

    expect(apps).toEqual([
      { appleId: '1000000001', name: 'hikeshi', bundleId: 'com.ihideck.hikeshi' },
      { appleId: '1000000002', name: 'とれろぐ', bundleId: 'com.ihideck.machosterone' },
    ]);
    const [first, second] = requestedUrls(fetchFn);
    expect(first?.searchParams.get('fields[apps]')).toBe('name,bundleId');
    expect(second?.href).toBe('https://api.appstoreconnect.apple.com/v1/apps?cursor=AQ');
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer TOKEN',
    );
  });

  it('データの無いページのあとは、links.next があってもたどらない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': [
        page([app('1000000001', 'hikeshi', 'com.ihideck.hikeshi')], {
          next: '/v1/apps?cursor=AQ',
        }),
        page([], { next: '/v1/apps?cursor=Ag' }),
        page([app('1000000002', 'とれろぐ', 'com.ihideck.machosterone')]),
      ],
    });

    const apps = await listApps(createClient(() => 'TOKEN', fetchFn));

    expect(apps.map(({ appleId }) => appleId)).toEqual(['1000000001']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('次のページの URL が App Store Connect API でなければ、トークンを送らずに止める', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': jsonResponse(200, {
        data: [app('1000000001', 'hikeshi', 'com.ihideck.hikeshi')],
        links: { next: 'https://example.com/v1/apps?cursor=AQ' },
      }),
    });

    await expect(listApps(createClient(() => 'TOKEN', fetchFn))).rejects.toThrow(
      'https://example.com',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('エラーの応答は、状態のコードと、Apple のエラーと、直し方を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': jsonResponse(401, {
        errors: [
          {
            status: '401',
            code: 'NOT_AUTHORIZED',
            title: 'Authentication credentials are missing or invalid.',
            detail: 'Provide a properly configured and signed bearer token.',
          },
        ],
      }),
    });

    const result = listApps(createClient(() => 'TOKEN', fetchFn));

    await expect(result).rejects.toBeInstanceOf(AscApiError);
    await expect(result).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/401[\s\S]*Issuer ID[\s\S]*NOT_AUTHORIZED/),
    });
  });

  it('契約の同意が切れているときは、ロールでなく、契約への同意を求める', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': jsonResponse(403, {
        errors: [
          {
            status: '403',
            code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED',
            title: 'A required agreement is missing or has expired.',
          },
        ],
      }),
    });

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
    const fetchFn = fakeFetch({
      '/v1/apps': page([resource('apps', '1000000001', { bundleId: 'com.ihideck.hikeshi' })]),
    });

    await expect(listApps(createClient(() => 'TOKEN', fetchFn))).rejects.toThrow(
      /\/v1\/apps[\s\S]*attributes\.name/,
    );
  });
});

describe('findApp', () => {
  it('バンドル ID がまったく同じアプリを返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': page([
        app('1000000003', 'ひけし 2', 'com.ihideck.hikeshi2'),
        app('1000000001', 'ひけし', 'com.ihideck.hikeshi'),
      ]),
    });

    const found = await findApp(
      createClient(() => 'TOKEN', fetchFn),
      'com.ihideck.hikeshi',
    );

    expect(found).toEqual({
      appleId: '1000000001',
      name: 'ひけし',
      bundleId: 'com.ihideck.hikeshi',
    });
    expect(requestedUrls(fetchFn)[0]?.searchParams.get('filter[bundleId]')).toBe(
      'com.ihideck.hikeshi',
    );
  });

  it('無いときは、list_apps で一覧を見るよう返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': page([app('1000000003', 'ひけし 2', 'com.ihideck.hikeshi2')]),
    });

    await expect(
      findApp(
        createClient(() => 'TOKEN', fetchFn),
        'com.ihideck.hikeshi',
      ),
    ).rejects.toThrow(/com\.ihideck\.hikeshi のアプリは[\s\S]*list_apps/);
  });
});
