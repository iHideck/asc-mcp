import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { setFreePrice } from '../plugin/src/price.ts';
import { created, fakeFetch, jsonResponse, page, resource, sentWrites } from './fake-api.ts';

const APP_ID = '6831431413';
const BUNDLE_ID = 'com.ihideck.languessr';
const SCHEDULE = `/v1/apps/${APP_ID}/appPriceSchedule`;
const MANUAL_PRICES = '/v1/appPriceSchedules/ps1/manualPrices';
const PRICE_POINTS = `/v1/apps/${APP_ID}/appPricePoints`;
const TODAY = new Date('2026-11-08T03:00:00Z');

function missing() {
  return jsonResponse(404, { errors: [{ status: '404', code: 'NOT_FOUND' }] });
}

function schedule(baseTerritory = 'JPN') {
  return jsonResponse(200, {
    data: resource(
      'appPriceSchedules',
      'ps1',
      {},
      { baseTerritory: `territories:${baseTerritory}` },
    ),
  });
}

type Entry = { point: string; price: string; startDate?: string; endDate?: string };

function manualPrices(...entries: Entry[]) {
  return page(
    entries.map(({ point, startDate, endDate }, index) =>
      resource(
        'appPrices',
        `p${index}`,
        { startDate: startDate ?? null, endDate: endDate ?? null },
        { appPricePoint: `appPricePoints:${point}` },
      ),
    ),
    {
      included: entries.map(({ point, price }) =>
        resource('appPricePoints', point, { customerPrice: price }),
      ),
    },
  );
}

function pricePoints() {
  return page([
    resource('appPricePoints', 'pp120', { customerPrice: '120' }),
    resource('appPricePoints', 'pp0', { customerPrice: '0' }),
  ]);
}

function app() {
  return page([resource('apps', APP_ID, { name: 'Languessr', bundleId: BUNDLE_ID })]);
}

function set(fetchFn: typeof fetch, baseTerritory = 'JPN') {
  return setFreePrice(
    createClient(() => 'TOKEN', fetchFn),
    { bundleId: BUNDLE_ID, baseTerritory },
    () => TODAY,
  );
}

describe('setFreePrice', () => {
  it('価格の予定が無ければ、基準の国の無料の価格の点で作り、前と後を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [SCHEDULE]: [missing(), schedule()],
      [MANUAL_PRICES]: manualPrices({ point: 'pp0', price: '0' }),
      [PRICE_POINTS]: pricePoints(),
      'POST /v1/appPriceSchedules': created('appPriceSchedules', 'ps1'),
    });

    const result = await set(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/appPriceSchedules',
        body: {
          data: {
            type: 'appPriceSchedules',
            relationships: {
              app: { data: { type: 'apps', id: APP_ID } },
              baseTerritory: { data: { type: 'territories', id: 'JPN' } },
              manualPrices: { data: [{ type: 'appPrices', id: '${price}' }] },
            },
          },
          included: [
            {
              type: 'appPrices',
              id: '${price}',
              attributes: { startDate: null },
              relationships: { appPricePoint: { data: { type: 'appPricePoints', id: 'pp0' } } },
            },
          ],
        },
      },
    ]);
    expect(result.before).toBeNull();
    expect(result.after).toEqual({ baseTerritory: 'JPN', customerPrice: '0' });
  });

  it('もう無料なら、何も送らない。今の価格は、今日に当たるものを見る', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [SCHEDULE]: schedule(),
      [MANUAL_PRICES]: manualPrices(
        { point: 'pp0', price: '0.0', startDate: '2026-01-01', endDate: '2026-12-01' },
        { point: 'pp120', price: '120', startDate: '2026-12-01' },
      ),
    });

    const result = await set(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.after).toEqual({ baseTerritory: 'JPN', customerPrice: '0.0' });
  });

  it('有料なら、無料の予定を作る', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [SCHEDULE]: [schedule(), schedule()],
      [MANUAL_PRICES]: [
        manualPrices({ point: 'pp120', price: '120' }),
        manualPrices({ point: 'pp0', price: '0' }),
      ],
      [PRICE_POINTS]: pricePoints(),
      'POST /v1/appPriceSchedules': created('appPriceSchedules', 'ps1'),
    });

    const result = await set(fetchFn);

    expect(sentWrites(fetchFn)).toHaveLength(1);
    expect([result.before?.customerPrice, result.after?.customerPrice]).toEqual(['120', '0']);
  });

  it('基準の国に無料の価格の点が無ければ、何も送らずに止める', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [SCHEDULE]: missing(),
      [PRICE_POINTS]: page([resource('appPricePoints', 'pp120', { customerPrice: '120' })]),
    });

    await expect(set(fetchFn, 'XXX')).rejects.toThrow('XXX に、無料の価格の点がありません');
    expect(sentWrites(fetchFn)).toEqual([]);
  });
});
