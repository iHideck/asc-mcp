import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { sparseFields, toMany, toOne, type AscClient, type Attributes } from './client.ts';
import {
  EDITABLE_APP_INFO_STATES,
  findEditableAppInfo,
  listCurrentAppInfos,
} from './localizations.ts';
import { trackProgress } from './progress.ts';
import type { Platform } from './versions.ts';

const FREQUENCIES = ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE', 'INFREQUENT', 'FREQUENT'];

// 年齢制限の答えの項目。Apple の仕様（AgeRatingDeclarationUpdateRequest）と同じものを、テストで照らす
export const AGE_RATING_FIELDS: Record<string, 'boolean' | 'string' | readonly string[]> = {
  advertising: 'boolean',
  alcoholTobaccoOrDrugUseOrReferences: FREQUENCIES,
  contests: FREQUENCIES,
  gambling: 'boolean',
  gamblingSimulated: FREQUENCIES,
  gunsOrOtherWeapons: FREQUENCIES,
  healthOrWellnessTopics: 'boolean',
  kidsAgeBand: ['FIVE_AND_UNDER', 'SIX_TO_EIGHT', 'NINE_TO_ELEVEN'],
  lootBox: 'boolean',
  medicalOrTreatmentInformation: FREQUENCIES,
  messagingAndChat: 'boolean',
  parentalControls: 'boolean',
  profanityOrCrudeHumor: FREQUENCIES,
  ageAssurance: 'boolean',
  sexualContentGraphicAndNudity: FREQUENCIES,
  sexualContentOrNudity: FREQUENCIES,
  socialMedia: 'boolean',
  socialMediaAgeRestricted: 'boolean',
  horrorOrFearThemes: FREQUENCIES,
  matureOrSuggestiveThemes: FREQUENCIES,
  unrestrictedWebAccess: 'boolean',
  userGeneratedContent: 'boolean',
  violenceCartoonOrFantasy: FREQUENCIES,
  violenceRealisticProlongedGraphicOrSadistic: FREQUENCIES,
  violenceRealistic: FREQUENCIES,
  ageRatingOverrideV2: [
    'NONE',
    'NINE_PLUS',
    'THIRTEEN_PLUS',
    'SIXTEEN_PLUS',
    'EIGHTEEN_PLUS',
    'UNRATED',
  ],
  koreaAgeRatingOverride: ['NONE', 'ALL', 'TWELVE_PLUS', 'FIFTEEN_PLUS', 'NINETEEN_PLUS'],
  gracRatingClassificationNumber: 'string',
  developerAgeRatingInfoUrl: 'string',
};

const AGE_RATING_NAMES = Object.keys(AGE_RATING_FIELDS);

export const CATEGORY_SLOTS = [
  'primaryCategory',
  'primarySubcategoryOne',
  'primarySubcategoryTwo',
  'secondaryCategory',
  'secondarySubcategoryOne',
  'secondarySubcategoryTwo',
] as const;
type CategorySlot = (typeof CATEGORY_SLOTS)[number];

export const CONTENT_RIGHTS = [
  'DOES_NOT_USE_THIRD_PARTY_CONTENT',
  'USES_THIRD_PARTY_CONTENT',
] as const;

export const ageRatingInput = z.object(
  Object.fromEntries(
    AGE_RATING_NAMES.map((name) => {
      const kind = AGE_RATING_FIELDS[name];
      const value =
        kind === 'boolean'
          ? z.boolean()
          : kind === 'string'
            ? z.string()
            : z.enum(kind as [string, ...string[]]);
      return [name, value.nullable().optional()];
    }),
  ) as Record<string, z.ZodOptional<z.ZodNullable<z.ZodType<string | boolean>>>>,
);

type AgeRatingValues = Record<string, string | boolean | null>;

const AppInfoResource = z.object({
  type: z.literal('appInfos'),
  id: z.string(),
  attributes: z.object({ state: z.string(), appStoreAgeRating: z.string().nullable() }),
  relationships: z.object({
    primaryCategory: toOne,
    primarySubcategoryOne: toOne,
    primarySubcategoryTwo: toOne,
    secondaryCategory: toOne,
    secondarySubcategoryOne: toOne,
    secondarySubcategoryTwo: toOne,
    ageRatingDeclaration: toOne,
  }),
});

const AgeRatingDeclaration = z.object({
  type: z.literal('ageRatingDeclarations'),
  id: z.string(),
  attributes: z.object(
    Object.fromEntries(
      AGE_RATING_NAMES.map((name) => [name, z.union([z.string(), z.boolean()]).nullish()]),
    ),
  ),
});

const AppRights = z.object({
  type: z.literal('apps'),
  id: z.string(),
  attributes: z.object({ contentRightsDeclaration: z.string().nullable() }),
});

const Category = z.object({
  type: z.literal('appCategories'),
  id: z.string(),
  attributes: z.object({ platforms: z.array(z.string()).nullish() }),
  relationships: z.object({ subcategories: toMany }),
});

export type SetAppInfoRequest = {
  bundleId: string;
  platform: Platform;
  contentRightsDeclaration?: (typeof CONTENT_RIGHTS)[number] | undefined;
  ageRating?: Partial<AgeRatingValues> | undefined;
} & Partial<Record<CategorySlot, string | undefined>>;

export type AppInfoState = {
  appInfoState: string;
  categories: Record<CategorySlot, string | null>;
  contentRightsDeclaration: string | null;
  appStoreAgeRating: string | null;
  ageRating: AgeRatingValues;
};

export type SetAppInfoResult = {
  app: AppSummary;
  before: AppInfoState;
  after: AppInfoState;
  warnings: string[];
};

export async function setAppInfo(
  client: AscClient,
  request: SetAppInfoRequest,
): Promise<SetAppInfoResult> {
  const app = await findApp(client, request.bundleId);
  const categories = CATEGORY_SLOTS.filter((slot) => request[slot] !== undefined);
  const ageRating = Object.entries(request.ageRating ?? {}).filter(
    ([, value]) => value !== undefined,
  );
  const touchesAppInfo = categories.length > 0 || ageRating.length > 0;
  const appInfoId = touchesAppInfo
    ? (await findEditableAppInfo(client, app.appleId, 'カテゴリ・年齢制限')).id
    : await shownAppInfo(client, app.appleId);
  const read = () => readState(client, app.appleId, appInfoId);
  const before = await read();
  if (categories.length > 0) {
    await checkCategories(client, request, before.state.categories);
  }
  const declarationId = before.declarationId;
  if (ageRating.length > 0 && declarationId === null) {
    throw new Error(
      'App 情報に、年齢制限の答えがありません。App Store Connect で確かめてください。何も変えていません。',
    );
  }
  const categoryChanges = categories.filter(
    (slot) => request[slot] !== before.state.categories[slot],
  );
  const rightsChanged =
    request.contentRightsDeclaration !== undefined &&
    request.contentRightsDeclaration !== before.state.contentRightsDeclaration;
  const ageRatingChanges = Object.fromEntries(
    ageRating.filter(([name, value]) => value !== before.state.ageRating[name]),
  ) as Attributes;

  const progress = trackProgress();
  if (categoryChanges.length > 0) {
    await progress.write('カテゴリを変える', 'カテゴリを変えました', () =>
      client.update(
        'appInfos',
        appInfoId,
        {},
        Object.fromEntries(
          categoryChanges.map((slot) => [slot, { type: 'appCategories', id: request[slot] ?? '' }]),
        ),
      ),
    );
  }
  if (rightsChanged && request.contentRightsDeclaration !== undefined) {
    const declaration = request.contentRightsDeclaration;
    await progress.write('コンテンツ配信権を変える', 'コンテンツ配信権を変えました', () =>
      client.update('apps', app.appleId, { contentRightsDeclaration: declaration }),
    );
  }
  if (Object.keys(ageRatingChanges).length > 0 && declarationId !== null) {
    await progress.write('年齢制限の答えを変える', '年齢制限の答えを変えました', () =>
      client.update('ageRatingDeclarations', declarationId, ageRatingChanges),
    );
  }
  const changed =
    categoryChanges.length > 0 || rightsChanged || Object.keys(ageRatingChanges).length > 0;
  const after = changed ? await progress.read('変えた App 情報を読み直す', read) : before;
  return {
    app,
    before: before.state,
    after: after.state,
    warnings: warningsFor(after.state, request, categories, ageRating),
  };
}

// 何も変えないときは、編集できる App 情報があればそれを、無ければ公開中のものを見せる
async function shownAppInfo(client: AscClient, appleId: string): Promise<string> {
  const appInfos = await listCurrentAppInfos(client, appleId);
  const appInfo =
    appInfos.find(({ state }) => EDITABLE_APP_INFO_STATES.includes(state)) ?? appInfos[0];
  if (appInfo === undefined) {
    throw new Error('App 情報を、読めませんでした。');
  }
  return appInfo.id;
}

async function readState(
  client: AscClient,
  appleId: string,
  appInfoId: string,
): Promise<{ state: AppInfoState; declarationId: string | null }> {
  const [appInfo, rights] = await Promise.all([
    client.getOne(`/v1/appInfos/${appInfoId}`, sparseFields(AppInfoResource), AppInfoResource),
    client.getOne(`/v1/apps/${appleId}`, sparseFields(AppRights), AppRights),
  ]);
  if (appInfo === null) {
    throw new Error('App 情報を、読めませんでした。');
  }
  const declaration = await client.getOne(
    `/v1/appInfos/${appInfoId}/ageRatingDeclaration`,
    sparseFields(AgeRatingDeclaration),
    AgeRatingDeclaration,
  );
  const { relationships, attributes } = appInfo;
  return {
    state: {
      appInfoState: attributes.state,
      categories: Object.fromEntries(
        CATEGORY_SLOTS.map((slot) => [slot, relationships[slot]?.data?.id ?? null]),
      ) as Record<CategorySlot, string | null>,
      contentRightsDeclaration: rights?.attributes.contentRightsDeclaration ?? null,
      appStoreAgeRating: attributes.appStoreAgeRating,
      ageRating: Object.fromEntries(
        AGE_RATING_NAMES.map((name) => [name, declaration?.attributes[name] ?? null]),
      ),
    },
    declarationId: declaration?.id ?? relationships.ageRatingDeclaration?.data?.id ?? null,
  };
}

async function checkCategories(
  client: AscClient,
  request: SetAppInfoRequest,
  current: Record<CategorySlot, string | null>,
): Promise<void> {
  const { data } = await client.getAll(
    '/v1/appCategories',
    {
      ...sparseFields(Category),
      'filter[platforms]': request.platform,
      'exists[parent]': 'false',
      'limit[subcategories]': '50',
      limit: '200',
    },
    { data: Category },
  );
  const subcategoriesOf = new Map(
    data.map(({ id, relationships }) => [
      id,
      (relationships.subcategories?.data ?? []).map((item) => item.id),
    ]),
  );
  const problems: string[] = [];
  for (const [main, subs] of [
    ['primaryCategory', ['primarySubcategoryOne', 'primarySubcategoryTwo']],
    ['secondaryCategory', ['secondarySubcategoryOne', 'secondarySubcategoryTwo']],
  ] as const) {
    const category = request[main] ?? current[main];
    if (request[main] !== undefined && !subcategoriesOf.has(request[main])) {
      problems.push(`${main} に ${request[main]} は使えません`);
    }
    for (const sub of subs) {
      const value = request[sub];
      if (value !== undefined && !(subcategoriesOf.get(category ?? '') ?? []).includes(value)) {
        problems.push(
          `${sub} に ${value} は使えません（${category ?? 'カテゴリ未設定'} のサブカテゴリではありません）`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${problems.join('。\n')}。\n使えるカテゴリは ${[...subcategoriesOf.keys()].join('、')} です。何も変えていません。`,
    );
  }
}

function warningsFor(
  after: AppInfoState,
  request: SetAppInfoRequest,
  categories: readonly CategorySlot[],
  ageRating: [string, string | boolean | null | undefined][],
): string[] {
  const differences = [
    ...categories
      .filter((slot) => after.categories[slot] !== request[slot])
      .map(
        (slot) =>
          `${slot} が ${String(after.categories[slot])} です（頼んだのは ${String(request[slot])}）`,
      ),
    ...(request.contentRightsDeclaration !== undefined &&
    after.contentRightsDeclaration !== request.contentRightsDeclaration
      ? [`コンテンツ配信権が ${String(after.contentRightsDeclaration)} です`]
      : []),
    ...ageRating
      .filter(([name, value]) => after.ageRating[name] !== value)
      .map(([name]) => `年齢制限の ${name} が ${String(after.ageRating[name])} です`),
  ].map((text) => `App Store Connect の値が、頼んだものと違います: ${text}`);
  const unrated =
    after.appStoreAgeRating === null
      ? [
          `App Store の年齢が、まだ決まっていません。年齢制限の答えが足りないかもしれません（答えていない項目: ${AGE_RATING_NAMES.filter((name) => after.ageRating[name] === null).join('、')}）。`,
        ]
      : [];
  return [...differences, ...unrated];
}
