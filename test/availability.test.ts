import { describe, expect, it } from 'vitest';
import { setAvailability, type SetAvailabilityRequest } from '../plugin/src/availability.ts';
import { createClient } from '../plugin/src/client.ts';
import { created, fakeFetch, jsonResponse, page, resource, sentWrites } from './fake-api.ts';

const APP_ID = '6831431413';
const BUNDLE_ID = 'com.ihideck.languessr';
const SOURCE_ID = '6826307654';
const SOURCE = 'com.ihideck.machosterone';
const AVAILABILITY = `/v1/apps/${APP_ID}/appAvailabilityV2`;
const SOURCE_AVAILABILITY = `/v1/apps/${SOURCE_ID}/appAvailabilityV2`;

function missing() {
  return jsonResponse(404, { errors: [{ status: '404', code: 'NOT_FOUND' }] });
}

function availability(id: string, availableInNewTerritories: boolean) {
  return jsonResponse(200, {
    data: resource('appAvailabilities', id, { availableInNewTerritories }),
  });
}

// 国ごとの配信は「国:配信するか」で書く
function territoryAvailabilities(...entries: string[]) {
  return page(
    entries.map((entry) => {
      const [territory = '', available = ''] = entry.split(':');
      return resource(
        'territoryAvailabilities',
        `ta-${territory}`,
        { available: available === 'true' },
        { territory: `territories:${territory}` },
      );
    }),
  );
}

function territories() {
  return page(
    [
      ['JPN', 'JPY'],
      ['USA', 'USD'],
      ['GBR', 'GBP'],
    ].map(([id, currency]) => resource('territories', id ?? '', { currency })),
  );
}

function app(id: string, bundleId: string) {
  return page([resource('apps', id, { name: bundleId, bundleId })]);
}

function set(fetchFn: typeof fetch, request: Omit<SetAvailabilityRequest, 'bundleId'>) {
  return setAvailability(
    createClient(() => 'TOKEN', fetchFn),
    { bundleId: BUNDLE_ID, ...request },
  );
}

function routesOf(fetchFn: ReturnType<typeof fakeFetch>) {
  return sentWrites(fetchFn).map(({ method, path, body }) => [method, path, body]);
}

describe('setAvailability', () => {
  it('配信の設定が無ければ、すべての国について配信するかを入れて作る', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(APP_ID, BUNDLE_ID),
      '/v1/territories': territories(),
      [AVAILABILITY]: [missing(), availability('av1', false)],
      '/v2/appAvailabilities/av1/territoryAvailabilities': territoryAvailabilities(
        'JPN:true',
        'USA:true',
        'GBR:false',
      ),
      'POST /v2/appAvailabilities': created('appAvailabilities', 'av1'),
    });

    const result = await set(fetchFn, { territories: ['JPN', 'USA'] });

    const inline = (id: string, available: boolean) => ({
      type: 'territoryAvailabilities',
      id: `\${${id}}`,
      attributes: { available },
      relationships: { territory: { data: { type: 'territories', id } } },
    });
    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v2/appAvailabilities',
        body: {
          data: {
            type: 'appAvailabilities',
            attributes: { availableInNewTerritories: false },
            relationships: {
              app: { data: { type: 'apps', id: APP_ID } },
              territoryAvailabilities: {
                data: ['JPN', 'USA', 'GBR'].map((id) => ({
                  type: 'territoryAvailabilities',
                  id: `\${${id}}`,
                })),
              },
            },
          },
          included: [inline('JPN', true), inline('USA', true), inline('GBR', false)],
        },
      },
    ]);
    expect(result.before).toBeNull();
    expect(result.after).toEqual({ availableInNewTerritories: false, territories: ['JPN', 'USA'] });
  });

  it('配信の設定があれば、違う国だけを変える', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(APP_ID, BUNDLE_ID),
      '/v1/territories': territories(),
      [AVAILABILITY]: [availability('av1', false), availability('av1', false)],
      '/v2/appAvailabilities/av1/territoryAvailabilities': [
        territoryAvailabilities('JPN:true', 'USA:false', 'GBR:true'),
        territoryAvailabilities('JPN:true', 'USA:true', 'GBR:false'),
      ],
      'PATCH /v1/territoryAvailabilities/ta-USA': jsonResponse(200, { data: {} }),
      'PATCH /v1/territoryAvailabilities/ta-GBR': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, { territories: ['JPN', 'USA'] });

    expect(routesOf(fetchFn)).toEqual([
      [
        'PATCH',
        '/v1/territoryAvailabilities/ta-USA',
        {
          data: { type: 'territoryAvailabilities', id: 'ta-USA', attributes: { available: true } },
        },
      ],
      [
        'PATCH',
        '/v1/territoryAvailabilities/ta-GBR',
        {
          data: { type: 'territoryAvailabilities', id: 'ta-GBR', attributes: { available: false } },
        },
      ],
    ]);
    expect([result.before?.territories, result.after?.territories]).toEqual([
      ['GBR', 'JPN'],
      ['JPN', 'USA'],
    ]);
  });

  it('ほかのアプリと同じ国にし、新しい国の扱いもそのアプリに合わせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': [app(APP_ID, BUNDLE_ID), app(SOURCE_ID, SOURCE)],
      '/v1/territories': territories(),
      [SOURCE_AVAILABILITY]: availability('src', true),
      '/v2/appAvailabilities/src/territoryAvailabilities': territoryAvailabilities(
        'JPN:true',
        'USA:false',
        'GBR:true',
      ),
      [AVAILABILITY]: [missing(), availability('av1', true)],
      '/v2/appAvailabilities/av1/territoryAvailabilities': territoryAvailabilities(
        'JPN:true',
        'USA:false',
        'GBR:true',
      ),
      'POST /v2/appAvailabilities': created('appAvailabilities', 'av1'),
    });

    const result = await set(fetchFn, { sameAsApp: SOURCE });

    const body = sentWrites(fetchFn)[0]?.body as {
      data: { attributes: object };
      included: { attributes: { available: boolean } }[];
    };
    expect(body.data.attributes).toEqual({ availableInNewTerritories: true });
    expect(body.included.map(({ attributes }) => attributes.available)).toEqual([
      true,
      false,
      true,
    ]);
    expect(result.after).toEqual({ availableInNewTerritories: true, territories: ['GBR', 'JPN'] });
  });

  it('頼んだとおりなら、何も送らない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(APP_ID, BUNDLE_ID),
      '/v1/territories': territories(),
      [AVAILABILITY]: availability('av1', false),
      '/v2/appAvailabilities/av1/territoryAvailabilities': territoryAvailabilities(
        'JPN:true',
        'USA:false',
        'GBR:false',
      ),
    });

    const result = await set(fetchFn, { territories: ['JPN'] });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.after).toEqual(result.before);
  });

  it('知らない国と、引数の渡し方の誤りは、何も送らずに止める', async () => {
    const unknown = fakeFetch({
      '/v1/apps': app(APP_ID, BUNDLE_ID),
      '/v1/territories': territories(),
    });
    const neither = fakeFetch({});

    await expect(set(unknown, { territories: ['JPN', 'JAP'] })).rejects.toThrow(
      '国の ID JAP はありません',
    );
    await expect(set(neither, {})).rejects.toThrow('どちらか一方を渡してください');
    await expect(set(neither, { territories: ['JPN'], sameAsApp: SOURCE })).rejects.toThrow(
      'どちらか一方を渡してください',
    );
    expect(sentWrites(unknown)).toEqual([]);
    expect(neither).not.toHaveBeenCalled();
  });

  it('新しい国の扱いは、作ったあとは変えられないので、頼まれたら止め、合わせるだけなら知らせる', async () => {
    const routes = () => ({
      '/v1/territories': territories(),
      [AVAILABILITY]: availability('av1', false),
      '/v2/appAvailabilities/av1/territoryAvailabilities': territoryAvailabilities(
        'JPN:true',
        'USA:false',
        'GBR:true',
      ),
    });
    const explicit = fakeFetch({ '/v1/apps': app(APP_ID, BUNDLE_ID), ...routes() });
    const copied = fakeFetch({
      '/v1/apps': [app(APP_ID, BUNDLE_ID), app(SOURCE_ID, SOURCE)],
      ...routes(),
      [SOURCE_AVAILABILITY]: availability('src', true),
      '/v2/appAvailabilities/src/territoryAvailabilities': territoryAvailabilities(
        'JPN:true',
        'USA:false',
        'GBR:true',
      ),
    });

    await expect(
      set(explicit, { territories: ['JPN', 'GBR'], availableInNewTerritories: true }),
    ).rejects.toThrow('一度入れると API では変えられません');
    const result = await set(copied, { sameAsApp: SOURCE });

    expect([...sentWrites(explicit), ...sentWrites(copied)]).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('新しい国でも自動で配信するか')]);
  });
});
