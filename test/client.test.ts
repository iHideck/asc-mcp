import { describe, expect, it } from 'vitest';
import { listApps } from '../plugin/src/apps.ts';
import { createClient, isReadOnly } from '../plugin/src/client.ts';
import { created, fakeFetch, jsonResponse, sentWrites } from './fake-api.ts';

const VERSION = { type: 'appStoreVersions', id: 'v1' };

describe('createClient', () => {
  it('書かない設定では、作る・変える・消すのどれも送らない', async () => {
    const fetchFn = fakeFetch({});
    const client = createClient(() => 'TOKEN', fetchFn, true);

    await expect(
      client.create(
        'appStoreVersionPhasedReleases',
        { phasedReleaseState: 'INACTIVE' },
        { appStoreVersion: VERSION },
      ),
    ).rejects.toThrow('送りませんでした: POST /v1/appStoreVersionPhasedReleases');
    await expect(
      client.update('appStoreVersions', 'v1', { releaseType: 'MANUAL' }),
    ).rejects.toThrow('送りませんでした: PATCH /v1/appStoreVersions/v1');
    await expect(client.remove('appStoreVersionPhasedReleases', 'p1')).rejects.toThrow(
      '送りませんでした: DELETE /v1/appStoreVersionPhasedReleases/p1',
    );
    await expect(
      client.upload(
        {
          method: 'PUT',
          url: 'https://store-001.blobstore.apple.com/s1/part1?token=x',
          offset: 0,
          length: 3,
          requestHeaders: [],
        },
        new Uint8Array([1, 2, 3]),
      ),
    ).rejects.toThrow(
      '送りませんでした: PUT https://store-001.blobstore.apple.com/s1/part1（3 バイト）',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('書かない設定は、値が無いか 0 のときだけ外す', () => {
    expect([undefined, '', '0'].map(isReadOnly)).toEqual([false, false, false]);
    expect(['1', 'true', 'yes'].map(isReadOnly)).toEqual([true, true, true]);
  });

  it('書く操作で 5xx が返ったら、届いたか分からないことを添える。読む操作には添えない', async () => {
    const gatewayTimeout = () =>
      jsonResponse(504, { errors: [{ status: '504', code: 'GATEWAY_TIMEOUT' }] });
    const fetchFn = fakeFetch({
      'PATCH /v1/appStoreVersions/v1': gatewayTimeout(),
      '/v1/apps': gatewayTimeout(),
    });
    const client = createClient(() => 'TOKEN', fetchFn);

    await expect(
      client.update('appStoreVersions', 'v1', { releaseType: 'MANUAL' }),
    ).rejects.toThrow(/504[\s\S]*届いたかは分かりません/);
    const read = await listApps(client).catch((error: unknown) =>
      error instanceof Error ? error.message : '',
    );
    expect(read).toContain('504');
    expect(read).not.toContain('届いたかは分かりません');
  });

  it('作ったものを応答から読めなければ、届いたか分からないことを添える', async () => {
    const fetchFn = fakeFetch({
      'POST /v1/appStoreVersionPhasedReleases': jsonResponse(201, { data: null }),
    });

    await expect(
      createClient(() => 'TOKEN', fetchFn).create(
        'appStoreVersionPhasedReleases',
        { phasedReleaseState: 'INACTIVE' },
        { appStoreVersion: VERSION },
      ),
    ).rejects.toThrow(/作ったものを読めませんでした[\s\S]*届いたかは分かりません/);
  });
  it('Apple のエラーの associatedErrors も、項目ごとに返す', async () => {
    const fetchFn = fakeFetch({
      'PATCH /v1/reviewSubmissions/s1': jsonResponse(409, {
        errors: [
          {
            status: '409',
            code: 'STATE_ERROR.ENTITY_STATE_INVALID',
            title: 'The request cannot be fulfilled because of the state of another resource.',
            meta: {
              associatedErrors: {
                '/v1/appStoreVersions/v102': [
                  {
                    code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED',
                    detail: 'You must provide a value for the attribute whatsNew.',
                    source: { pointer: '/data/attributes/whatsNew' },
                  },
                ],
              },
            },
          },
        ],
      }),
    });

    await expect(
      createClient(() => 'TOKEN', fetchFn).update('reviewSubmissions', 's1', { submitted: true }),
    ).rejects.toThrow(
      '- /v1/appStoreVersions/v102: ENTITY_ERROR.ATTRIBUTE.REQUIRED: You must provide a value for the attribute whatsNew.（/data/attributes/whatsNew）',
    );
  });

  it('作るものに属性が無ければ、attributes を送らない', async () => {
    const fetchFn = fakeFetch({
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
    });

    await createClient(() => 'TOKEN', fetchFn).create(
      'reviewSubmissionItems',
      {},
      { reviewSubmission: { type: 'reviewSubmissions', id: 's1' } },
    );

    expect(sentWrites(fetchFn)[0]?.body).toEqual({
      data: {
        type: 'reviewSubmissionItems',
        relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: 's1' } } },
      },
    });
  });
});
