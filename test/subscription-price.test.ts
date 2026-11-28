import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import {
  setIntroductoryOffer,
  setSubscriptionPrice,
  type SetIntroductoryOfferRequest,
  type SetSubscriptionPriceRequest,
} from '../plugin/src/subscription-price.ts';
import { created, fakeFetch, noContent, page, sentWrites } from './fake-api.ts';
import {
  app,
  BUNDLE_ID,
  group,
  GROUPS,
  offer,
  planAvailability,
  price,
  pricePoint,
  pricePointId,
  PRODUCT_ID,
  subscription,
  territory,
} from './subscription-fixtures.ts';

const NOW = Date.parse('2026-11-24T03:00:00Z');
const PLANS = '/v1/subscriptions/s1/planAvailabilities';
const PLAN_TERRITORIES = '/v1/subscriptionPlanAvailabilities/pa1/availableTerritories';
const PRICES = '/v1/subscriptions/s1/prices';
const OFFERS = '/v1/subscriptions/s1/introductoryOffers';

function client(fetchFn: typeof fetch) {
  return createClient(() => 'TOKEN', fetchFn);
}

function routesOf(fetchFn: ReturnType<typeof fakeFetch>): string[] {
  return sentWrites(fetchFn).map(({ method, path }) => `${method} ${path}`);
}

function base() {
  return {
    '/v1/apps': app(),
    [GROUPS]: page([group()]),
    '/v1/subscriptionGroups/g1/subscriptions': page([subscription()]),
  };
}

// 日本の 480 円を基準にすると、アメリカは 2.99 ドル、イギリスは 2.99 ポンドになる
function priceRoutes() {
  return {
    ...base(),
    '/v1/territories': page(['JPN', 'USA', 'GBR', 'CAN'].map(territory)),
    '/v1/subscriptions/s1/pricePoints': page([
      pricePoint('JPN', 1, '450'),
      pricePoint('JPN', 2, '480'),
      pricePoint('JPN', 3, '500'),
      pricePoint('JPN', 4, '1000'),
    ]),
    [`/v1/subscriptionPricePoints/${pricePointId('JPN', 2)}/equalizations`]: page(
      [pricePoint('USA', 2, '2.99'), pricePoint('GBR', 2, '2.99'), pricePoint('CAN', 2, '3.99')],
      { included: ['USA', 'GBR', 'CAN'].map(territory) },
    ),
  };
}

const priceRequest: SetSubscriptionPriceRequest = {
  bundleId: BUNDLE_ID,
  productId: PRODUCT_ID,
  baseTerritory: 'JPN',
  price: '480',
  territories: ['USA', 'JPN', 'GBR'],
};

function setPrice(fetchFn: typeof fetch, overrides: Partial<SetSubscriptionPriceRequest> = {}) {
  return setSubscriptionPrice(client(fetchFn), { ...priceRequest, ...overrides }, () => NOW);
}

describe('setSubscriptionPrice', () => {
  it('国を決めてから、基準の国の価格に近い価格を、売らない国も含めて国ごとに入れる', async () => {
    const fetchFn = fakeFetch({
      ...priceRoutes(),
      [PLANS]: [page([]), page([planAvailability('pa1')])],
      [PLAN_TERRITORIES]: page(['GBR', 'JPN', 'USA'].map(territory)),
      [PRICES]: page([]),
      'POST /v1/subscriptionPlanAvailabilities': created('subscriptionPlanAvailabilities', 'pa1'),
      'POST /v1/subscriptionPrices': [
        created('subscriptionPrices', 'p1'),
        created('subscriptionPrices', 'p2'),
        created('subscriptionPrices', 'p3'),
        created('subscriptionPrices', 'p4'),
      ],
    });

    const result = await setPrice(fetchFn, { availableInNewTerritories: false });

    const writes = sentWrites(fetchFn);
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/v1/subscriptionPlanAvailabilities',
      body: {
        data: {
          type: 'subscriptionPlanAvailabilities',
          attributes: { planType: 'UPFRONT', availableInNewTerritories: false },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: 's1' } },
            availableTerritories: {
              data: ['GBR', 'JPN', 'USA'].map((id) => ({ type: 'territories', id })),
            },
          },
        },
      },
    });
    expect(writes.slice(1).map(({ body }) => body)).toEqual(
      ['CAN', 'GBR', 'JPN', 'USA'].map((id) => ({
        data: {
          type: 'subscriptionPrices',
          attributes: { startDate: null, planType: 'UPFRONT' },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: 's1' } },
            subscriptionPricePoint: {
              data: { type: 'subscriptionPricePoints', id: pricePointId(id, 2) },
            },
          },
        },
      })),
    );
    expect(result).toMatchObject({
      territories: { before: [], after: ['GBR', 'JPN', 'USA'] },
      changedPrices: ['CAN', 'GBR', 'JPN', 'USA'],
      unchangedPrices: 0,
    });
  });

  it('違う国と価格だけを変え、予約された価格は消す。毎月払いの価格は見ない', async () => {
    const fetchFn = fakeFetch({
      ...priceRoutes(),
      [PLANS]: [
        page([planAvailability('pm1', 'MONTHLY'), planAvailability('pa1')]),
        page([planAvailability('pa1')]),
      ],
      [PLAN_TERRITORIES]: [
        page(['CAN', 'GBR', 'JPN', 'USA'].map(territory)),
        page(['GBR', 'JPN', 'USA'].map(territory)),
      ],
      [PRICES]: page(
        [
          price('old-jpn', 'JPN', 1, '2026-01-01'),
          price('cur-jpn', 'JPN', 2, '2026-06-01'),
          price('cur-usa', 'USA', 1, null),
          price('cur-gbr', 'GBR', 2, null),
          price('next-gbr', 'GBR', 3, '2027-01-01'),
          price('monthly-usa', 'USA', 2, null, 'MONTHLY'),
        ],
        {
          included: [
            pricePoint('JPN', 1, '450'),
            pricePoint('JPN', 2, '480'),
            pricePoint('USA', 1, '1.99'),
            pricePoint('GBR', 2, '2.99'),
            pricePoint('GBR', 3, '3.99'),
            pricePoint('USA', 2, '2.99'),
            ...['JPN', 'USA', 'GBR'].map(territory),
          ],
        },
      ),
      'PATCH /v1/subscriptionPlanAvailabilities/pa1/relationships/availableTerritories':
        noContent(),
      'DELETE /v1/subscriptionPrices/next-gbr': noContent(),
      'POST /v1/subscriptionPrices': [
        created('subscriptionPrices', 'p1'),
        created('subscriptionPrices', 'p2'),
      ],
    });

    const result = await setPrice(fetchFn);

    expect(routesOf(fetchFn)).toEqual([
      'PATCH /v1/subscriptionPlanAvailabilities/pa1/relationships/availableTerritories',
      'POST /v1/subscriptionPrices',
      'DELETE /v1/subscriptionPrices/next-gbr',
      'POST /v1/subscriptionPrices',
    ]);
    expect(sentWrites(fetchFn)[1]?.body).toMatchObject({
      data: {
        relationships: {
          subscriptionPricePoint: {
            data: { type: 'subscriptionPricePoints', id: pricePointId('CAN', 2) },
          },
        },
      },
    });
    expect(sentWrites(fetchFn)[3]?.body).toMatchObject({
      data: {
        relationships: {
          subscriptionPricePoint: {
            data: { type: 'subscriptionPricePoints', id: pricePointId('USA', 2) },
          },
        },
      },
    });
    expect(result).toMatchObject({
      territories: { before: ['CAN', 'GBR', 'JPN', 'USA'], after: ['GBR', 'JPN', 'USA'] },
      changedPrices: ['CAN', 'GBR', 'USA'],
      unchangedPrices: 1,
    });
  });

  it('同じ国を重ねて渡しても、1つとして扱う', async () => {
    const fetchFn = fakeFetch({
      ...priceRoutes(),
      [PLANS]: [page([planAvailability('pa1')]), page([planAvailability('pa1')])],
      [PLAN_TERRITORIES]: [
        page(['GBR', 'JPN', 'USA'].map(territory)),
        page(['JPN', 'USA'].map(territory)),
      ],
      [PRICES]: page([]),
      'PATCH /v1/subscriptionPlanAvailabilities/pa1/relationships/availableTerritories':
        noContent(),
      'POST /v1/subscriptionPrices': ['p1', 'p2', 'p3', 'p4'].map((id) =>
        created('subscriptionPrices', id),
      ),
    });

    await setPrice(fetchFn, { territories: ['JPN', 'JPN', 'USA'] });

    expect(routesOf(fetchFn)[0]).toBe(
      'PATCH /v1/subscriptionPlanAvailabilities/pa1/relationships/availableTerritories',
    );
    expect(sentWrites(fetchFn)[0]?.body).toMatchObject({
      data: ['JPN', 'USA'].map((id) => ({ type: 'territories', id })),
    });
  });

  it('基準の国に、その価格が無ければ、近い価格を挙げて何も送らない', async () => {
    const fetchFn = fakeFetch(priceRoutes());

    await expect(setPrice(fetchFn, { price: '490' })).rejects.toThrow(
      'JPN has no price point of 490. The nearest prices are 450, 480, 500, 1000.',
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('知らない国や、基準の国を含まない国の一覧は、何も送らずに返す', async () => {
    for (const [territories, message] of [
      [['JPN', 'XXX'], /Unknown territory IDs: XXX/],
      [['USA'], /Include the base territory JPN/],
    ] as const) {
      const fetchFn = fakeFetch(priceRoutes());

      await expect(setPrice(fetchFn, { territories: [...territories] })).rejects.toThrow(message);
      expect(sentWrites(fetchFn)).toEqual([]);
    }
  });

  it('商品が無ければ、ensure_subscription で作るよう返す', async () => {
    const fetchFn = fakeFetch({ ...base(), '/v1/subscriptionGroups/g1/subscriptions': page([]) });

    await expect(setPrice(fetchFn)).rejects.toThrow(/Create it with ensure_subscription/);
  });
});

const offerRequest: SetIntroductoryOfferRequest = {
  bundleId: BUNDLE_ID,
  productId: PRODUCT_ID,
  duration: 'ONE_WEEK',
};

function setOffer(fetchFn: typeof fetch, overrides: Partial<SetIntroductoryOfferRequest> = {}) {
  return setIntroductoryOffer(client(fetchFn), { ...offerRequest, ...overrides }, () => NOW);
}

function offerRoutes(offers: ReturnType<typeof offer>[]) {
  return {
    ...base(),
    [PLANS]: page([planAvailability('pa1')]),
    [PLAN_TERRITORIES]: page(['JPN', 'USA'].map(territory)),
    [OFFERS]: page(offers, { included: ['JPN', 'USA'].map(territory) }),
  };
}

describe('setIntroductoryOffer', () => {
  it('売っている国ごとに、無料期間を入れる', async () => {
    const fetchFn = fakeFetch({
      ...offerRoutes([]),
      'POST /v1/subscriptionIntroductoryOffers': [
        created('subscriptionIntroductoryOffers', 'o1'),
        created('subscriptionIntroductoryOffers', 'o2'),
      ],
    });

    const result = await setOffer(fetchFn);

    expect(sentWrites(fetchFn).map(({ body }) => body)).toEqual(
      ['JPN', 'USA'].map((id) => ({
        data: {
          type: 'subscriptionIntroductoryOffers',
          attributes: { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK', numberOfPeriods: 1 },
          relationships: {
            subscription: { data: { type: 'subscriptions', id: 's1' } },
            territory: { data: { type: 'territories', id } },
          },
        },
      })),
    );
    expect(result).toMatchObject({ changedTerritories: ['JPN', 'USA'], unchangedTerritories: 0 });
  });

  it('同じ無料期間の国は変えず、違う国は、いまのオファーを消してから入れる。終わったオファーは見ない', async () => {
    const fetchFn = fakeFetch({
      ...offerRoutes([
        offer('jpn', 'JPN', { startDate: '2026-10-01' }),
        offer('usa', 'USA', { duration: 'ONE_MONTH' }),
        offer('ended', 'USA', { endDate: '2026-11-01' }),
        offer('monthly', 'JPN', { duration: 'ONE_MONTH', targetSubscriptionPlanType: 'MONTHLY' }),
      ]),
      'DELETE /v1/subscriptionIntroductoryOffers/usa': noContent(),
      'POST /v1/subscriptionIntroductoryOffers': created('subscriptionIntroductoryOffers', 'o1'),
    });

    const result = await setOffer(fetchFn);

    expect(routesOf(fetchFn)).toEqual([
      'DELETE /v1/subscriptionIntroductoryOffers/usa',
      'POST /v1/subscriptionIntroductoryOffers',
    ]);
    expect(result).toMatchObject({ changedTerritories: ['USA'], unchangedTerritories: 1 });
  });

  it('売っていない国には入れず、何も送らない', async () => {
    const noPlan = fakeFetch({ ...base(), [PLANS]: page([]) });
    const outside = fakeFetch(offerRoutes([]));

    await expect(setOffer(noPlan)).rejects.toThrow(/set_subscription_price first/);
    await expect(setOffer(outside, { territories: ['GBR'] })).rejects.toThrow(
      /not available in GBR/,
    );
    expect([...sentWrites(noPlan), ...sentWrites(outside)]).toEqual([]);
  });
});
