import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import {
  ensureSubscription,
  type EnsureSubscriptionRequest,
} from '../plugin/src/ensure-subscription.ts';
import { created, fakeFetch, jsonResponse, noContent, page, sentWrites } from './fake-api.ts';
import {
  app,
  BUNDLE_ID,
  group,
  groupLocalization,
  groupVersion,
  GROUPS,
  none,
  PRODUCT_ID,
  reserved,
  reviewScreenshot,
  subscription,
  subscriptionLocalization,
  subscriptionVersion,
  UPLOAD,
} from './subscription-fixtures.ts';

const SUBSCRIPTIONS = '/v1/subscriptionGroups/g1/subscriptions';
const GROUP_VERSIONS = '/v1/subscriptionGroups/g1/versions';
const VERSIONS = '/v1/subscriptions/s1/versions';
const SCREENSHOT = '/v1/subscriptions/s1/appStoreReviewScreenshot';

let dir: string;
const pictures = {
  review: png(1206, 2622, 'review'),
  other: png(1206, 2622, 'other'),
  wrongSize: png(1000, 1000, 'wrong'),
};

function png(width: number, height: number, seed: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`seed\0${seed}`)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pathOf(name: keyof typeof pictures): string {
  return join(dir, `${name}.png`);
}

function md5(name: keyof typeof pictures): string {
  return createHash('md5').update(pictures[name]).digest('hex');
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asc-mcp-subscription-'));
  await Promise.all(
    Object.entries(pictures).map(([name, bytes]) => writeFile(join(dir, `${name}.png`), bytes)),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request: EnsureSubscriptionRequest = {
  bundleId: BUNDLE_ID,
  groupReferenceName: 'Premium',
  groupLocalizations: [{ locale: 'ja', name: 'プレミアム' }],
  productId: PRODUCT_ID,
  referenceName: 'Monthly',
  subscriptionPeriod: 'ONE_MONTH',
  familySharable: false,
  localizations: [{ locale: 'ja', name: '月額プラン', description: 'すべての機能を使える' }],
};

function ensure(fetchFn: typeof fetch, overrides: Partial<EnsureSubscriptionRequest> = {}) {
  return ensureSubscription(
    createClient(() => 'TOKEN', fetchFn),
    { ...request, ...overrides },
    async () => {},
  );
}

function routesOf(fetchFn: ReturnType<typeof fakeFetch>): string[] {
  return sentWrites(fetchFn).map(({ method, path }) => `${method} ${path}`);
}

// 同じ GET を何度読んでもよいように、同じ応答を多めに積む
function many(make: () => Response): Response[] {
  return Array.from({ length: 6 }, make);
}

// すでに頼んだとおりになっている状態
function existing(extra: Record<string, Response | Response[]> = {}) {
  return {
    '/v1/apps': app(),
    [GROUPS]: page([group()]),
    [SUBSCRIPTIONS]: many(() => page([subscription()])),
    [GROUP_VERSIONS]: many(() => page([groupVersion('gv1', 1, 'APPROVED')])),
    '/v1/subscriptionGroupVersions/gv1/localizations': many(() =>
      page([groupLocalization('gl1', 'ja', 'プレミアム')]),
    ),
    [VERSIONS]: many(() => page([subscriptionVersion('sv1', 1, 'PREPARE_FOR_SUBMISSION')])),
    '/v1/subscriptionVersions/sv1/localizations': many(() =>
      page([subscriptionLocalization('sl1', 'ja', '月額プラン', 'すべての機能を使える')]),
    ),
    [SCREENSHOT]: many(() =>
      jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'COMPLETE') }),
    ),
    ...extra,
  };
}

describe('ensureSubscription', () => {
  it('グループも商品も無ければ作り、版を作って言語ごとの文を入れ、審査用の写真を上げる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [GROUPS]: page([]),
      'POST /v1/subscriptionGroups': created('subscriptionGroups', 'g1'),
      [GROUP_VERSIONS]: [page([]), page([groupVersion('gv1', 1, 'PREPARE_FOR_SUBMISSION')])],
      'POST /v1/subscriptionGroupVersions': created('subscriptionGroupVersions', 'gv1'),
      '/v1/subscriptionGroupVersions/gv1/localizations': [
        page([]),
        page([groupLocalization('gl1', 'ja', 'プレミアム')]),
      ],
      'POST /v2/subscriptionGroupLocalizations': created('subscriptionGroupLocalizations', 'gl1'),
      'POST /v1/subscriptions': created('subscriptions', 's1'),
      [VERSIONS]: [page([]), page([subscriptionVersion('sv1', 1, 'PREPARE_FOR_SUBMISSION')])],
      'POST /v1/subscriptionVersions': created('subscriptionVersions', 'sv1'),
      '/v1/subscriptionVersions/sv1/localizations': [
        page([]),
        page([subscriptionLocalization('sl1', 'ja', '月額プラン', 'すべての機能を使える')]),
      ],
      'POST /v2/subscriptionLocalizations': created('subscriptionLocalizations', 'sl1'),
      [SCREENSHOT]: [
        none(),
        jsonResponse(200, { data: reviewScreenshot('rs1', null, 'UPLOAD_COMPLETE') }),
        jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'COMPLETE') }),
        jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'COMPLETE') }),
      ],
      'POST /v1/subscriptionAppStoreReviewScreenshots': reserved('rs1', pictures.review.length),
      [`PUT ${UPLOAD}/rs1/part1`]: new Response(null, { status: 200 }),
      'PATCH /v1/subscriptionAppStoreReviewScreenshots/rs1': jsonResponse(200, {
        data: reviewScreenshot('rs1', md5('review'), 'UPLOAD_COMPLETE'),
      }),
      [SUBSCRIPTIONS]: page([subscription()]),
    });

    const result = await ensure(fetchFn, {
      reviewNote: '設定の画面から買えます',
      reviewScreenshot: pathOf('review'),
    });

    const writes = sentWrites(fetchFn);
    expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /v1/subscriptionGroups',
      'POST /v1/subscriptionGroupVersions',
      'POST /v2/subscriptionGroupLocalizations',
      'POST /v1/subscriptions',
      'POST /v1/subscriptionVersions',
      'POST /v2/subscriptionLocalizations',
      'POST /v1/subscriptionAppStoreReviewScreenshots',
      `PUT ${UPLOAD}/rs1/part1`.replace(UPLOAD, ''),
      'PATCH /v1/subscriptionAppStoreReviewScreenshots/rs1',
    ]);
    expect(writes[3]?.body).toEqual({
      data: {
        type: 'subscriptions',
        attributes: {
          productId: PRODUCT_ID,
          name: 'Monthly',
          subscriptionPeriod: 'ONE_MONTH',
          familySharable: false,
          reviewNote: '設定の画面から買えます',
        },
        relationships: { group: { data: { type: 'subscriptionGroups', id: 'g1' } } },
      },
    });
    expect(writes[5]?.body).toEqual({
      data: {
        type: 'subscriptionLocalizations',
        attributes: { locale: 'ja', name: '月額プラン', description: 'すべての機能を使える' },
        relationships: { version: { data: { type: 'subscriptionVersions', id: 'sv1' } } },
      },
    });
    expect(writes[8]?.body).toEqual({
      data: {
        type: 'subscriptionAppStoreReviewScreenshots',
        id: 'rs1',
        attributes: { uploaded: true, sourceFileChecksum: md5('review') },
      },
    });
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({
      groupReferenceName: 'Premium',
      productId: PRODUCT_ID,
      reviewScreenshot: { state: 'COMPLETE' },
    });
    expect(result.warnings).toEqual([]);
  });

  it('頼んだとおりなら、何も送らない', async () => {
    const fetchFn = fakeFetch(existing());

    const result = await ensure(fetchFn, { reviewScreenshot: pathOf('review') });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.after).toEqual(result.before);
  });

  it('違う値だけを変える。承認された版の文を変えるときは、新しい版を作ってから変える', async () => {
    const fetchFn = fakeFetch(
      existing({
        [GROUP_VERSIONS]: [
          page([groupVersion('gv1', 1, 'APPROVED')]),
          page([groupVersion('gv1', 1, 'APPROVED')]),
          page([groupVersion('gv1', 1, 'APPROVED')]),
          page([
            groupVersion('gv2', 2, 'PREPARE_FOR_SUBMISSION'),
            groupVersion('gv1', 1, 'APPROVED'),
          ]),
        ],
        'POST /v1/subscriptionGroupVersions': created('subscriptionGroupVersions', 'gv2'),
        '/v1/subscriptionGroupVersions/gv1/localizations': many(() =>
          page([groupLocalization('gl1', 'ja', 'プレミアム')]),
        ),
        '/v1/subscriptionGroupVersions/gv2/localizations': [
          page([groupLocalization('gl2', 'ja', 'プレミアム')]),
          page([groupLocalization('gl2', 'ja', 'プレミアム', 'いびきトーク')]),
        ],
        'PATCH /v2/subscriptionGroupLocalizations/gl2': jsonResponse(200, {
          data: groupLocalization('gl2', 'ja', 'プレミアム', 'いびきトーク'),
        }),
        'PATCH /v1/subscriptions/s1': jsonResponse(200, { data: subscription() }),
        'POST /v2/subscriptionLocalizations': created('subscriptionLocalizations', 'sl2'),
      }),
    );

    await ensure(fetchFn, {
      groupLocalizations: [{ locale: 'ja', name: 'プレミアム', customAppName: 'いびきトーク' }],
      referenceName: 'Monthly plan',
      reviewNote: 'メモ',
      localizations: [
        { locale: 'ja', name: '月額プラン', description: 'すべての機能を使える' },
        { locale: 'en-US', name: 'Monthly' },
      ],
    });

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/subscriptionGroupVersions',
        body: {
          data: {
            type: 'subscriptionGroupVersions',
            relationships: {
              subscriptionGroup: { data: { type: 'subscriptionGroups', id: 'g1' } },
            },
          },
        },
      },
      {
        method: 'PATCH',
        path: '/v2/subscriptionGroupLocalizations/gl2',
        body: {
          data: {
            type: 'subscriptionGroupLocalizations',
            id: 'gl2',
            attributes: { customAppName: 'いびきトーク' },
          },
        },
      },
      {
        method: 'PATCH',
        path: '/v1/subscriptions/s1',
        body: {
          data: {
            type: 'subscriptions',
            id: 's1',
            attributes: { name: 'Monthly plan', reviewNote: 'メモ' },
          },
        },
      },
      {
        method: 'POST',
        path: '/v2/subscriptionLocalizations',
        body: {
          data: {
            type: 'subscriptionLocalizations',
            attributes: { locale: 'en-US', name: 'Monthly' },
            relationships: { version: { data: { type: 'subscriptionVersions', id: 'sv1' } } },
          },
        },
      },
    ]);
  });

  it('審査中の版の文は変えず、何も送らない', async () => {
    const fetchFn = fakeFetch(
      existing({
        [VERSIONS]: many(() => page([subscriptionVersion('sv1', 1, 'WAITING_FOR_REVIEW')])),
      }),
    );

    await expect(
      ensure(fetchFn, {
        reviewNote: '別のメモ',
        localizations: [{ locale: 'ja', name: '別の名前' }],
      }),
    ).rejects.toThrow(/WAITING_FOR_REVIEW[\s\S]*Nothing was changed/);
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('審査用の写真が違えば、いまの写真を消してから上げる', async () => {
    const fetchFn = fakeFetch(
      existing({
        [SCREENSHOT]: [
          jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'COMPLETE') }),
          jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'COMPLETE') }),
          jsonResponse(200, { data: reviewScreenshot('rs2', md5('other'), 'COMPLETE') }),
          jsonResponse(200, { data: reviewScreenshot('rs2', md5('other'), 'COMPLETE') }),
        ],
        'DELETE /v1/subscriptionAppStoreReviewScreenshots/rs1': noContent(),
        'POST /v1/subscriptionAppStoreReviewScreenshots': reserved('rs2', pictures.other.length),
        [`PUT ${UPLOAD}/rs2/part1`]: new Response(null, { status: 200 }),
        'PATCH /v1/subscriptionAppStoreReviewScreenshots/rs2': jsonResponse(200, {
          data: reviewScreenshot('rs2', md5('other'), 'UPLOAD_COMPLETE'),
        }),
      }),
    );

    await ensure(fetchFn, { reviewScreenshot: pathOf('other') });

    expect(routesOf(fetchFn)).toEqual([
      'DELETE /v1/subscriptionAppStoreReviewScreenshots/rs1',
      'POST /v1/subscriptionAppStoreReviewScreenshots',
      'PUT /rs2/part1',
      'PATCH /v1/subscriptionAppStoreReviewScreenshots/rs2',
    ]);
  });

  it('前に上げた同じ写真が処理中なら、消さずに終わるのを待つ', async () => {
    const fetchFn = fakeFetch(
      existing({
        [SCREENSHOT]: [
          jsonResponse(200, { data: reviewScreenshot('rs1', null, 'UPLOAD_COMPLETE') }),
          jsonResponse(200, { data: reviewScreenshot('rs1', null, 'COMPLETE') }),
          ...many(() =>
            jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'COMPLETE') }),
          ),
        ],
      }),
    );

    const result = await ensure(fetchFn, { reviewScreenshot: pathOf('review') });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('同じ写真でも、Apple が受け付けなかったものは上げ直す', async () => {
    const fetchFn = fakeFetch(
      existing({
        [SCREENSHOT]: [
          jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'FAILED') }),
          jsonResponse(200, { data: reviewScreenshot('rs1', md5('review'), 'FAILED') }),
          ...many(() =>
            jsonResponse(200, { data: reviewScreenshot('rs2', md5('review'), 'COMPLETE') }),
          ),
        ],
        'DELETE /v1/subscriptionAppStoreReviewScreenshots/rs1': noContent(),
        'POST /v1/subscriptionAppStoreReviewScreenshots': reserved('rs2', pictures.review.length),
        [`PUT ${UPLOAD}/rs2/part1`]: new Response(null, { status: 200 }),
        'PATCH /v1/subscriptionAppStoreReviewScreenshots/rs2': jsonResponse(200, {
          data: reviewScreenshot('rs2', md5('review'), 'UPLOAD_COMPLETE'),
        }),
      }),
    );

    await ensure(fetchFn, { reviewScreenshot: pathOf('review') });

    expect(routesOf(fetchFn)).toEqual([
      'DELETE /v1/subscriptionAppStoreReviewScreenshots/rs1',
      'POST /v1/subscriptionAppStoreReviewScreenshots',
      'PUT /rs2/part1',
      'PATCH /v1/subscriptionAppStoreReviewScreenshots/rs2',
    ]);
  });

  it('Apple が写真を受け付けなければ、理由を返す', async () => {
    const failed = jsonResponse(200, {
      data: {
        ...reviewScreenshot('rs1', null, 'FAILED'),
        attributes: {
          fileName: 'review.png',
          sourceFileChecksum: null,
          assetDeliveryState: {
            state: 'FAILED',
            errors: [{ code: 'IMAGE_TOOL_FAILURE', description: '読めない' }],
          },
        },
      },
    });
    const fetchFn = fakeFetch(
      existing({
        [SCREENSHOT]: [
          jsonResponse(200, { data: reviewScreenshot('rs0', md5('other'), 'COMPLETE') }),
          none(),
          failed,
        ],
        'POST /v1/subscriptionAppStoreReviewScreenshots': reserved('rs1', pictures.review.length),
        [`PUT ${UPLOAD}/rs1/part1`]: new Response(null, { status: 200 }),
        'PATCH /v1/subscriptionAppStoreReviewScreenshots/rs1': jsonResponse(200, {
          data: reviewScreenshot('rs1', null, 'UPLOAD_COMPLETE'),
        }),
      }),
    );

    await expect(ensure(fetchFn, { reviewScreenshot: pathOf('review') })).rejects.toThrow(
      /IMAGE_TOOL_FAILURE: 読めない/,
    );
  });

  it('送る前に分かる誤りは、何も送らずに返す', async () => {
    const cases: [Partial<EnsureSubscriptionRequest>, Record<string, Response>, RegExp][] = [
      [{ reviewScreenshot: pathOf('wrongSize') }, {}, /1000x1000 is not a screenshot size/],
      [{ reviewScreenshot: 'review.png' }, {}, /absolute path/],
      [
        { referenceName: undefined },
        { '/v1/apps': app(), [GROUPS]: page([group()]), [SUBSCRIPTIONS]: page([]) },
        /also pass referenceName and subscriptionPeriod/,
      ],
      [
        { groupReferenceName: 'Basic' },
        {
          '/v1/apps': app(),
          [GROUPS]: page([group(), group('g2', 'Basic')]),
          [SUBSCRIPTIONS]: page([subscription()]),
        },
        /is in the group "Premium", not "Basic"/,
      ],
    ];
    for (const [overrides, routes, message] of cases) {
      const fetchFn = fakeFetch(routes);

      await expect(ensure(fetchFn, overrides)).rejects.toThrow(message);
      expect(sentWrites(fetchFn)).toEqual([]);
    }
  });

  it('足りない項目を知らせる', async () => {
    const fetchFn = fakeFetch(
      existing({
        '/v1/subscriptionVersions/sv1/localizations': many(() => page([])),
        [SCREENSHOT]: many(none),
      }),
    );

    const result = await ensure(fetchFn, { localizations: undefined });

    expect(result.warnings).toEqual([
      expect.stringContaining('no localized display name and description'),
      expect.stringContaining('no review screenshot'),
    ]);
  });
});
