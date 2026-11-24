import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { getSubscriptions } from '../plugin/src/get-subscriptions.ts';
import { fakeFetch, jsonResponse, page, requestedUrls } from './fake-api.ts';
import {
  app,
  BUNDLE_ID,
  group,
  groupLocalization,
  groupVersion,
  GROUPS,
  none,
  offer,
  planAvailability,
  price,
  pricePoint,
  PRODUCT_ID,
  reviewScreenshot,
  subscription,
  subscriptionLocalization,
  subscriptionVersion,
  territory,
} from './subscription-fixtures.ts';

const NOW = Date.parse('2026-11-24T03:00:00Z');

function routes(subscriptions = page([subscription('s1', { reviewNote: 'メモ' })])) {
  return {
    '/v1/apps': app(),
    [GROUPS]: page([group()]),
    '/v1/subscriptionGroups/g1/versions': page([
      groupVersion('gv1', 1, 'APPROVED'),
      groupVersion('gv2', 2, 'PREPARE_FOR_SUBMISSION'),
    ]),
    '/v1/subscriptionGroupVersions/gv2/localizations': page([
      groupLocalization('gl2', 'ja', 'プレミアム', 'いびきトーク'),
    ]),
    '/v1/subscriptionGroups/g1/subscriptions': subscriptions,
    '/v1/subscriptions/s1/versions': page([subscriptionVersion('sv1', 1, 'APPROVED')]),
    '/v1/subscriptionVersions/sv1/localizations': page([
      subscriptionLocalization('sl1', 'ja', '月額プラン', 'すべての機能を使える'),
      subscriptionLocalization('sl2', 'en-US', 'Monthly', null),
    ]),
    '/v1/subscriptions/s1/appStoreReviewScreenshot': jsonResponse(200, {
      data: reviewScreenshot('rs1', 'abc', 'COMPLETE'),
    }),
    '/v1/subscriptions/s1/planAvailabilities': page([planAvailability('pa1')]),
    '/v1/subscriptionPlanAvailabilities/pa1/availableTerritories': page(
      ['JPN', 'USA'].map(territory),
    ),
    '/v1/subscriptions/s1/prices': page(
      [
        price('p1', 'JPN', 2, null),
        price('p2', 'USA', 2, '2026-01-01'),
        price('p3', 'USA', 3, '2027-01-01'),
      ],
      {
        included: [
          pricePoint('JPN', 2, '480'),
          pricePoint('USA', 2, '2.99'),
          pricePoint('USA', 3, '3.99'),
        ],
      },
    ),
    '/v1/subscriptions/s1/introductoryOffers': page([offer('o1', 'USA'), offer('o2', 'JPN')]),
  };
}

describe('getSubscriptions', () => {
  it('グループと商品を、言語ごとの文・国・価格・無料期間とあわせて返す', async () => {
    const fetchFn = fakeFetch(routes());

    const result = await getSubscriptions(
      createClient(() => 'TOKEN', fetchFn),
      { bundleId: BUNDLE_ID },
      () => NOW,
    );

    expect(result.groups).toEqual([
      {
        referenceName: 'Premium',
        localizations: {
          versionState: 'PREPARE_FOR_SUBMISSION',
          localizations: [{ locale: 'ja', name: 'プレミアム', customAppName: 'いびきトーク' }],
        },
        subscriptions: [
          {
            productId: PRODUCT_ID,
            referenceName: 'Monthly',
            subscriptionPeriod: 'ONE_MONTH',
            familySharable: false,
            state: 'READY_TO_SUBMIT',
            groupLevel: 1,
            reviewNote: 'メモ',
            localizations: {
              versionState: 'APPROVED',
              localizations: [
                { locale: 'en-US', name: 'Monthly', description: null },
                { locale: 'ja', name: '月額プラン', description: 'すべての機能を使える' },
              ],
            },
            reviewScreenshot: { fileName: 'review.png', state: 'COMPLETE' },
            availability: { availableInNewTerritories: true, territories: ['JPN', 'USA'] },
            prices: { JPN: '480', USA: '2.99' },
            scheduledPrices: [{ territory: 'USA', customerPrice: '3.99', startDate: '2027-01-01' }],
            introductoryOffers: [
              {
                offerMode: 'FREE_TRIAL',
                duration: 'ONE_WEEK',
                numberOfPeriods: 1,
                startDate: null,
                endDate: null,
                territories: ['JPN', 'USA'],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('商品 ID を渡すと、その商品だけを読み、ほかのグループは返さない', async () => {
    const fetchFn = fakeFetch({
      ...routes(),
      [GROUPS]: page([group(), group('g2', 'Basic')]),
      '/v1/subscriptionGroups/g2/versions': page([]),
      '/v1/subscriptionGroups/g2/subscriptions': page([]),
      '/v1/subscriptions/s1/appStoreReviewScreenshot': none(),
    });

    const result = await getSubscriptions(
      createClient(() => 'TOKEN', fetchFn),
      { bundleId: BUNDLE_ID, productId: PRODUCT_ID },
      () => NOW,
    );

    expect(result.groups.map(({ referenceName }) => referenceName)).toEqual(['Premium']);
    expect(result.groups[0]?.subscriptions[0]?.reviewScreenshot).toBeNull();
    const filters = requestedUrls(fetchFn)
      .filter(({ pathname }) => pathname.endsWith('/subscriptions'))
      .map(({ searchParams }) => searchParams.get('filter[productId]'));
    expect(filters).toEqual([PRODUCT_ID, PRODUCT_ID]);
  });
});
