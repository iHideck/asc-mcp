import { describe, expect, it } from 'vitest';
import {
  AGE_RATING_FIELDS,
  CONTENT_RIGHTS,
  setAppInfo,
  type SetAppInfoRequest,
} from '../plugin/src/app-info.ts';
import { createClient } from '../plugin/src/client.ts';
import { fakeFetch, jsonResponse, page, requestedUrls, resource, sentWrites } from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6831431413';
const BUNDLE_ID = 'com.ihideck.languessr';
const APP_INFOS = `/v1/apps/${APP_ID}/appInfos`;
const APP_INFO = '/v1/appInfos/i-edit';
const DECLARATION = '/v1/appInfos/i-edit/ageRatingDeclaration';
const APP = `/v1/apps/${APP_ID}`;

type Categories = Partial<Record<string, string>>;

function appInfo(rating: string | null, categories: Categories = {}) {
  const link = (id: string | undefined) => (id === undefined ? null : `appCategories:${id}`);
  return jsonResponse(200, {
    data: resource(
      'appInfos',
      'i-edit',
      { state: 'PREPARE_FOR_SUBMISSION', appStoreAgeRating: rating },
      {
        primaryCategory: link(categories.primaryCategory),
        primarySubcategoryOne: link(categories.primarySubcategoryOne),
        primarySubcategoryTwo: null,
        secondaryCategory: link(categories.secondaryCategory),
        secondarySubcategoryOne: null,
        secondarySubcategoryTwo: null,
        ageRatingDeclaration: 'ageRatingDeclarations:a1',
      },
    ),
  });
}

function declaration(values: Record<string, string | boolean | null> = {}) {
  return jsonResponse(200, {
    data: resource('ageRatingDeclarations', 'a1', {
      ...Object.fromEntries(Object.keys(AGE_RATING_FIELDS).map((name) => [name, null])),
      ...values,
    }),
  });
}

function rights(value: string | null) {
  return jsonResponse(200, {
    data: resource('apps', APP_ID, { contentRightsDeclaration: value }),
  });
}

function categories() {
  return page([
    resource(
      'appCategories',
      'GAMES',
      { platforms: ['IOS'] },
      {
        subcategories: ['appCategories:GAMES_TRIVIA', 'appCategories:GAMES_PUZZLE'],
      },
    ),
    resource('appCategories', 'EDUCATION', { platforms: ['IOS'] }, { subcategories: [] }),
  ]);
}

function appInfos(state = 'PREPARE_FOR_SUBMISSION') {
  return page([resource('appInfos', 'i-edit', { state })]);
}

function app() {
  return page([resource('apps', APP_ID, { name: 'Languessr', bundleId: BUNDLE_ID })]);
}

function set(fetchFn: typeof fetch, request: Partial<SetAppInfoRequest> = {}) {
  return setAppInfo(
    createClient(() => 'TOKEN', fetchFn),
    {
      bundleId: BUNDLE_ID,
      platform: 'IOS',
      ...request,
    },
  );
}

function patch(type: string, id: string, data: Record<string, unknown>) {
  return { method: 'PATCH', path: `/v1/${type}/${id}`, body: { data: { type, id, ...data } } };
}

const games = { primaryCategory: 'GAMES', primarySubcategoryOne: 'GAMES_TRIVIA' };

describe('setAppInfo', () => {
  it('変わる項目だけを送り、前と後と、App Store が決めた年齢を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [APP_INFOS]: appInfos(),
      [APP_INFO]: [appInfo(null), appInfo('FOUR_PLUS', games)],
      [DECLARATION]: [
        declaration(),
        declaration({ violenceCartoonOrFantasy: 'NONE', gambling: false }),
      ],
      [APP]: [rights(null), rights('DOES_NOT_USE_THIRD_PARTY_CONTENT')],
      '/v1/appCategories': categories(),
      [`PATCH ${APP_INFO}`]: jsonResponse(200, { data: {} }),
      [`PATCH ${APP}`]: jsonResponse(200, { data: {} }),
      'PATCH /v1/ageRatingDeclarations/a1': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, {
      ...games,
      contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT',
      ageRating: { violenceCartoonOrFantasy: 'NONE', gambling: false },
    });

    expect(sentWrites(fetchFn)).toEqual([
      patch('appInfos', 'i-edit', {
        relationships: {
          primaryCategory: { data: { type: 'appCategories', id: 'GAMES' } },
          primarySubcategoryOne: { data: { type: 'appCategories', id: 'GAMES_TRIVIA' } },
        },
      }),
      patch('apps', APP_ID, {
        attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' },
      }),
      patch('ageRatingDeclarations', 'a1', {
        attributes: { violenceCartoonOrFantasy: 'NONE', gambling: false },
      }),
    ]);
    expect(result.before).toMatchObject({
      appStoreAgeRating: null,
      contentRightsDeclaration: null,
      categories: { primaryCategory: null },
    });
    expect(result.after).toMatchObject({
      appInfoState: 'PREPARE_FOR_SUBMISSION',
      appStoreAgeRating: 'FOUR_PLUS',
      contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT',
      categories: games,
      ageRating: { violenceCartoonOrFantasy: 'NONE', gambling: false, lootBox: null },
    });
    expect(result.warnings).toEqual([]);
  });

  it('頼んだとおりなら、何も送らず、読み直さない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [APP_INFOS]: appInfos(),
      [APP_INFO]: appInfo('FOUR_PLUS', games),
      [DECLARATION]: declaration({ gambling: false }),
      [APP]: rights('DOES_NOT_USE_THIRD_PARTY_CONTENT'),
      '/v1/appCategories': categories(),
    });

    const result = await set(fetchFn, {
      ...games,
      contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT',
      ageRating: { gambling: false },
    });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(requestedUrls(fetchFn).filter(({ pathname }) => pathname === APP_INFO)).toHaveLength(1);
    expect(result.after).toEqual(result.before);
  });

  it('使えないカテゴリと、カテゴリに合わないサブカテゴリは、何も送らずに止める', async () => {
    const routes = () => ({
      '/v1/apps': app(),
      [APP_INFOS]: appInfos(),
      [APP_INFO]: appInfo(null),
      [DECLARATION]: declaration(),
      [APP]: rights(null),
      '/v1/appCategories': categories(),
    });
    const typo = fakeFetch(routes());
    const mismatched = fakeFetch(routes());

    await expect(set(typo, { primaryCategory: 'GAME' })).rejects.toThrow(
      /primaryCategory に GAME は使えません[\s\S]*使えるカテゴリは GAMES、EDUCATION です/,
    );
    await expect(
      set(mismatched, { primaryCategory: 'EDUCATION', primarySubcategoryOne: 'GAMES_TRIVIA' }),
    ).rejects.toThrow(/GAMES_TRIVIA は使えません（EDUCATION のサブカテゴリではありません）/);
    expect([...sentWrites(typo), ...sentWrites(mismatched)]).toEqual([]);
  });

  it('編集できる App 情報が無ければ、カテゴリは変えずに止め、コンテンツ配信権は変える', async () => {
    const live = fakeFetch({ '/v1/apps': app(), [APP_INFOS]: appInfos('READY_FOR_DISTRIBUTION') });
    const rightsOnly = fakeFetch({
      '/v1/apps': app(),
      [APP_INFOS]: appInfos('READY_FOR_DISTRIBUTION'),
      [APP_INFO]: [appInfo('FOUR_PLUS', games), appInfo('FOUR_PLUS', games)],
      [DECLARATION]: [declaration(), declaration()],
      [APP]: [rights(null), rights('USES_THIRD_PARTY_CONTENT')],
      [`PATCH ${APP}`]: jsonResponse(200, { data: {} }),
    });

    await expect(set(live, { primaryCategory: 'GAMES' })).rejects.toThrow(
      /App 情報（カテゴリ・年齢制限）に、いま編集できるものがありません/,
    );
    await set(rightsOnly, { contentRightsDeclaration: 'USES_THIRD_PARTY_CONTENT' });

    expect(sentWrites(live)).toEqual([]);
    expect(sentWrites(rightsOnly)).toEqual([
      patch('apps', APP_ID, {
        attributes: { contentRightsDeclaration: 'USES_THIRD_PARTY_CONTENT' },
      }),
    ]);
  });

  it('App Store の年齢がまだ決まっていなければ、答えていない項目を知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [APP_INFOS]: appInfos(),
      [APP_INFO]: [appInfo(null), appInfo(null)],
      [DECLARATION]: [declaration(), declaration({ gambling: false })],
      [APP]: [rights(null), rights(null)],
      'PATCH /v1/ageRatingDeclarations/a1': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, { ageRating: { gambling: false } });

    expect(result.warnings).toEqual([
      expect.stringMatching(/App Store の年齢が、まだ決まっていません[\s\S]*advertising/),
    ]);
    expect(result.warnings[0]).not.toContain('gambling、');
  });

  it('途中で失敗したら、済んだことを添えて返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [APP_INFOS]: appInfos(),
      [APP_INFO]: appInfo(null),
      [DECLARATION]: declaration(),
      [APP]: rights(null),
      '/v1/appCategories': categories(),
      [`PATCH ${APP_INFO}`]: jsonResponse(200, { data: {} }),
      [`PATCH ${APP}`]: jsonResponse(500, {
        errors: [{ status: '500', code: 'UNEXPECTED_ERROR' }],
      }),
    });

    await expect(
      set(fetchFn, {
        primaryCategory: 'GAMES',
        contentRightsDeclaration: 'USES_THIRD_PARTY_CONTENT',
      }),
    ).rejects.toThrow(/^カテゴリを変えました。コンテンツ配信権を変えるところで止まりました。/);
  });

  it('年齢制限の項目とコンテンツ配信権の値が、Apple の仕様と同じ', () => {
    const properties = specAt(
      '/components/schemas/AgeRatingDeclarationUpdateRequest/properties/data/properties/attributes/properties',
    ) as Record<string, { type?: string; enum?: string[]; deprecated?: boolean; $ref?: string }>;
    type Schema = { type?: string; enum?: string[]; deprecated?: boolean; $ref?: string };
    const resolve = (schema: Schema): Schema =>
      schema.$ref === undefined
        ? schema
        : { ...(specAt(schema.$ref.slice(1)) as Schema), ...schema };
    const current = Object.entries(properties)
      .map(([name, schema]) => [name, resolve(schema)] as const)
      .filter(([, schema]) => schema.deprecated !== true);
    expect(Object.keys(AGE_RATING_FIELDS).sort()).toEqual(current.map(([name]) => name).sort());
    for (const [name, schema] of current) {
      const kind = AGE_RATING_FIELDS[name];
      expect([name, kind === 'boolean' ? 'boolean' : 'string']).toEqual([name, schema.type]);
      expect([name, typeof kind === 'string' ? undefined : kind]).toEqual([name, schema.enum]);
    }
    expect(
      specAt(
        '/components/schemas/App/properties/attributes/properties/contentRightsDeclaration/enum',
      ),
    ).toEqual([...CONTENT_RIGHTS]);
  });
});
