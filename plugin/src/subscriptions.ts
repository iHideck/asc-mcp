import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { findIncluded, nullIfMissing, sparseFields, toOne, type AscClient } from './client.ts';
import type { Progress } from './progress.ts';

export const SUBSCRIPTION_PERIODS = [
  'ONE_WEEK',
  'ONE_MONTH',
  'TWO_MONTHS',
  'THREE_MONTHS',
  'SIX_MONTHS',
  'ONE_YEAR',
] as const;
export type SubscriptionPeriod = (typeof SUBSCRIPTION_PERIODS)[number];

// 毎月払い（MONTHLY）は、1年の商品に足す「12か月の約束で毎月払う」形。ふつうの払い方は UPFRONT
export const UPFRONT = 'UPFRONT';

const Group = z.object({
  type: z.literal('subscriptionGroups'),
  id: z.string(),
  attributes: z.object({ referenceName: z.string() }),
});

const Subscription = z.object({
  type: z.literal('subscriptions'),
  id: z.string(),
  attributes: z.object({
    name: z.string().nullish(),
    productId: z.string(),
    familySharable: z.boolean().nullish(),
    state: z.string().nullish(),
    subscriptionPeriod: z.string().nullish(),
    reviewNote: z.string().nullish(),
    groupLevel: z.number().nullish(),
  }),
});

export type SubscriptionResource = z.infer<typeof Subscription>;

const GroupVersion = z.object({
  type: z.literal('subscriptionGroupVersions'),
  id: z.string(),
  attributes: z.object({ version: z.number().nullish(), state: z.string() }),
});

const SubscriptionVersion = z.object({
  type: z.literal('subscriptionVersions'),
  id: z.string(),
  attributes: z.object({ version: z.number().nullish(), state: z.string() }),
});

const GroupLocalization = z.object({
  type: z.literal('subscriptionGroupLocalizations'),
  id: z.string(),
  attributes: z.object({
    locale: z.string(),
    name: z.string().nullish(),
    customAppName: z.string().nullish(),
  }),
});

const SubscriptionLocalization = z.object({
  type: z.literal('subscriptionLocalizations'),
  id: z.string(),
  attributes: z.object({
    locale: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
  }),
});

const ReviewScreenshot = z.object({
  type: z.literal('subscriptionAppStoreReviewScreenshots'),
  id: z.string(),
  attributes: z.object({
    fileName: z.string().nullish(),
    sourceFileChecksum: z.string().nullish(),
    assetDeliveryState: z
      .object({
        state: z.string(),
        errors: z
          .array(z.object({ code: z.string().nullish(), description: z.string().nullish() }))
          .nullish(),
      })
      .nullish(),
  }),
});

export type ReviewScreenshotResource = z.infer<typeof ReviewScreenshot>;

const PlanAvailability = z.object({
  type: z.literal('subscriptionPlanAvailabilities'),
  id: z.string(),
  attributes: z.object({
    planType: z.string().nullish(),
    availableInNewTerritories: z.boolean().nullish(),
  }),
});

const Territory = z.object({
  type: z.literal('territories'),
  id: z.string(),
  attributes: z.object({ currency: z.string().nullish() }),
});

const Price = z.object({
  type: z.literal('subscriptionPrices'),
  id: z.string(),
  attributes: z.object({ startDate: z.string().nullish(), planType: z.string().nullish() }),
  relationships: z.object({ territory: toOne, subscriptionPricePoint: toOne }),
});

export const PricePoint = z.object({
  type: z.literal('subscriptionPricePoints'),
  id: z.string(),
  attributes: z.object({ customerPrice: z.string() }),
  relationships: z.object({ territory: toOne }),
});

const IntroductoryOffer = z.object({
  type: z.literal('subscriptionIntroductoryOffers'),
  id: z.string(),
  attributes: z.object({
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    duration: z.string().nullish(),
    offerMode: z.string().nullish(),
    numberOfPeriods: z.number().nullish(),
  }),
  relationships: z.object({ territory: toOne }),
});

// 版の状態。編集できるのは、出す前と、却下されたもの
const EDITABLE_STATES: readonly string[] = [
  'PREPARE_FOR_SUBMISSION',
  'REJECTED',
  'DEVELOPER_REJECTED',
];
const IN_REVIEW_STATES: readonly string[] = ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW'];

export type LocalizedText = { locale: string } & Record<string, string | null>;

type Localized = { id: string; text: LocalizedText };

export type LocalizationsState = { versionState: string | null; localizations: LocalizedText[] };

type MetadataKind = {
  label: string;
  parent: { name: string; type: string };
  versionType: string;
  versionsPath: (parentId: string) => string;
  localizationsPath: (versionId: string) => string;
  localizationType: string;
  read: (client: AscClient, path: string) => Promise<Localized[]>;
  readVersions: (client: AscClient, path: string) => Promise<DraftVersion[]>;
};

type DraftVersion = { id: string; version: number; state: string };

export const GROUP_METADATA: MetadataKind = {
  label: 'subscription group',
  parent: { name: 'subscriptionGroup', type: 'subscriptionGroups' },
  versionType: 'subscriptionGroupVersions',
  versionsPath: (id) => `/v1/subscriptionGroups/${id}/versions`,
  localizationsPath: (id) => `/v1/subscriptionGroupVersions/${id}/localizations`,
  localizationType: 'subscriptionGroupLocalizations',
  async read(client, path) {
    const { data } = await client.getAll(
      path,
      { ...sparseFields(GroupLocalization), limit: '200' },
      { data: GroupLocalization },
    );
    return data.map(({ id, attributes }) => ({
      id,
      text: {
        locale: attributes.locale,
        name: attributes.name ?? null,
        customAppName: attributes.customAppName ?? null,
      },
    }));
  },
  async readVersions(client, path) {
    const { data } = await client.getAll(
      path,
      { ...sparseFields(GroupVersion), limit: '200' },
      { data: GroupVersion },
    );
    return data.map(toDraftVersion);
  },
};

export const SUBSCRIPTION_METADATA: MetadataKind = {
  label: 'subscription',
  parent: { name: 'subscription', type: 'subscriptions' },
  versionType: 'subscriptionVersions',
  versionsPath: (id) => `/v1/subscriptions/${id}/versions`,
  localizationsPath: (id) => `/v1/subscriptionVersions/${id}/localizations`,
  localizationType: 'subscriptionLocalizations',
  async read(client, path) {
    const { data } = await client.getAll(
      path,
      { ...sparseFields(SubscriptionLocalization), limit: '200' },
      { data: SubscriptionLocalization },
    );
    return data.map(({ id, attributes }) => ({
      id,
      text: {
        locale: attributes.locale,
        name: attributes.name ?? null,
        description: attributes.description ?? null,
      },
    }));
  },
  async readVersions(client, path) {
    const { data } = await client.getAll(
      path,
      { ...sparseFields(SubscriptionVersion), limit: '200' },
      { data: SubscriptionVersion },
    );
    return data.map(toDraftVersion);
  },
};

function toDraftVersion({
  id,
  attributes,
}: {
  id: string;
  attributes: { version?: number | null | undefined; state: string };
}): DraftVersion {
  return { id, version: attributes.version ?? 0, state: attributes.state };
}

async function latestVersion(
  client: AscClient,
  kind: MetadataKind,
  parentId: string,
): Promise<DraftVersion | undefined> {
  const versions = await kind.readVersions(client, kind.versionsPath(parentId));
  return versions.reduce<DraftVersion | undefined>(
    (latest, version) =>
      latest === undefined || version.version > latest.version ? version : latest,
    undefined,
  );
}

export async function readLocalizations(
  client: AscClient,
  kind: MetadataKind,
  parentId: string,
): Promise<LocalizationsState> {
  const version = await latestVersion(client, kind, parentId);
  if (version === undefined) {
    return { versionState: null, localizations: [] };
  }
  const localizations = await kind.read(client, kind.localizationsPath(version.id));
  return { versionState: version.state, localizations: sortByLocale(localizations) };
}

// 渡した言語だけを、作るか変える。渡さなかった言語は消さない
export async function syncLocalizations(
  client: AscClient,
  progress: Progress,
  kind: MetadataKind,
  parentId: string,
  wanted: LocalizedText[],
): Promise<{ before: LocalizationsState; changed: boolean }> {
  let version = await latestVersion(client, kind, parentId);
  let current =
    version === undefined ? [] : await kind.read(client, kind.localizationsPath(version.id));
  const before = {
    versionState: version?.state ?? null,
    localizations: sortByLocale(current),
  };
  if (planChanges(current, wanted).length === 0) {
    return { before, changed: false };
  }
  if (version !== undefined && IN_REVIEW_STATES.includes(version.state)) {
    throw new Error(
      `Cannot change the localized text of the ${kind.label} because its version is ${version.state}. Change it after App Review finishes.`,
    );
  }
  if (version === undefined || !EDITABLE_STATES.includes(version.state)) {
    // 新しい版は、いまの言語ごとの文を写して作られる
    const id = await progress.write(
      `creating a new version of the ${kind.label} to edit its localized text`,
      `Created a new version of the ${kind.label}`,
      () =>
        client.create(
          kind.versionType,
          {},
          { [kind.parent.name]: { type: kind.parent.type, id: parentId } },
        ),
    );
    version = { id, version: (version?.version ?? 0) + 1, state: 'PREPARE_FOR_SUBMISSION' };
    current = await progress.read(
      `reading the localized text of the new ${kind.label} version`,
      () => kind.read(client, kind.localizationsPath(id)),
    );
  }
  const versionId = version.id;
  for (const change of planChanges(current, wanted)) {
    if (change.id === undefined) {
      await progress.write(
        `adding ${change.locale} to the ${kind.label}`,
        `Added ${change.locale} to the ${kind.label}`,
        () =>
          client.create(
            kind.localizationType,
            { locale: change.locale, ...change.attributes },
            { version: { type: kind.versionType, id: versionId } },
          ),
      );
    } else {
      const id = change.id;
      await progress.write(
        `changing ${change.locale} of the ${kind.label}`,
        `Changed ${change.locale} of the ${kind.label}`,
        () => client.update(kind.localizationType, id, change.attributes),
      );
    }
  }
  return { before, changed: true };
}

function planChanges(
  current: Localized[],
  wanted: LocalizedText[],
): { id: string | undefined; locale: string; attributes: Record<string, string | null> }[] {
  return wanted.flatMap(({ locale, ...values }) => {
    const existing = current.find(({ text }) => text.locale === locale);
    const attributes = Object.fromEntries(
      Object.entries(values).filter(([name, value]) => existing?.text[name] !== value),
    );
    return Object.keys(attributes).length === 0
      ? []
      : [{ id: existing?.id, locale, attributes: existing === undefined ? values : attributes }];
  });
}

function sortByLocale(localizations: Localized[]): LocalizedText[] {
  return localizations.map(({ text }) => text).sort((a, b) => a.locale.localeCompare(b.locale));
}

export type GroupSummary = { id: string; referenceName: string };

export async function listGroups(client: AscClient, appleId: string): Promise<GroupSummary[]> {
  const { data } = await client.getAll(
    `/v1/apps/${appleId}/subscriptionGroups`,
    { ...sparseFields(Group), limit: '200' },
    { data: Group },
  );
  return data.map(({ id, attributes }) => ({ id, referenceName: attributes.referenceName }));
}

export async function listSubscriptions(
  client: AscClient,
  groupId: string,
  productId?: string,
): Promise<SubscriptionResource[]> {
  const { data } = await client.getAll(
    `/v1/subscriptionGroups/${groupId}/subscriptions`,
    {
      ...sparseFields(Subscription),
      ...(productId === undefined ? {} : { 'filter[productId]': productId }),
      limit: '200',
    },
    { data: Subscription },
  );
  return data;
}

export type FoundSubscription = { group: GroupSummary; subscription: SubscriptionResource };

// 商品 ID はアプリの中で一意なので、どのグループにあるかを順に探す
export async function findSubscription(
  client: AscClient,
  groups: GroupSummary[],
  productId: string,
): Promise<FoundSubscription | undefined> {
  for (const group of groups) {
    const subscription = (await listSubscriptions(client, group.id, productId)).find(
      ({ attributes }) => attributes.productId === productId,
    );
    if (subscription !== undefined) {
      return { group, subscription };
    }
  }
  return undefined;
}

export async function requireSubscription(
  client: AscClient,
  bundleId: string,
  productId: string,
): Promise<{ app: AppSummary } & FoundSubscription> {
  const app = await findApp(client, bundleId);
  const found = await findSubscription(client, await listGroups(client, app.appleId), productId);
  if (found === undefined) {
    throw new Error(
      `No subscription has the product ID ${productId} in ${bundleId}. Create it with ensure_subscription.`,
    );
  }
  return { app, ...found };
}

export async function readReviewScreenshot(
  client: AscClient,
  subscriptionId: string,
): Promise<ReviewScreenshotResource | null> {
  return nullIfMissing(
    client.getOne(
      `/v1/subscriptions/${subscriptionId}/appStoreReviewScreenshot`,
      sparseFields(ReviewScreenshot),
      ReviewScreenshot,
    ),
  );
}

export { ReviewScreenshot };

export type PlanAvailabilityState = {
  id: string;
  availableInNewTerritories: boolean | null;
  territories: string[];
};

export async function readUpfrontAvailability(
  client: AscClient,
  subscriptionId: string,
): Promise<PlanAvailabilityState | null> {
  const { data } = await client.getAll(
    `/v1/subscriptions/${subscriptionId}/planAvailabilities`,
    { ...sparseFields(PlanAvailability), limit: '200' },
    { data: PlanAvailability },
  );
  const upfront = data.find(({ attributes }) => attributes.planType === UPFRONT);
  if (upfront === undefined) {
    return null;
  }
  const territories = await client.getAll(
    `/v1/subscriptionPlanAvailabilities/${upfront.id}/availableTerritories`,
    { ...sparseFields(Territory), limit: '200' },
    { data: Territory },
  );
  return {
    id: upfront.id,
    availableInNewTerritories: upfront.attributes.availableInNewTerritories ?? null,
    territories: territories.data.map(({ id }) => id).sort(),
  };
}

export async function listTerritoryIds(client: AscClient): Promise<string[]> {
  const { data } = await client.getAll(
    '/v1/territories',
    { ...sparseFields(Territory), limit: '200' },
    { data: Territory },
  );
  return data.map(({ id }) => id);
}

export type PriceEntry = {
  id: string;
  territory: string;
  pricePointId: string;
  customerPrice: string | null;
  startDate: string | null;
};

export type TerritoryPrices = { current: PriceEntry | undefined; scheduled: PriceEntry[] };

// 毎月払い（MONTHLY）の価格は、ふつうの価格と別に持つので、ここでは読まない
export async function readUpfrontPrices(
  client: AscClient,
  subscriptionId: string,
  today: string,
): Promise<Map<string, TerritoryPrices>> {
  const { data, included } = await client.getAll(
    `/v1/subscriptions/${subscriptionId}/prices`,
    { ...sparseFields(Price, PricePoint, Territory), limit: '200' },
    { data: Price, included: z.discriminatedUnion('type', [PricePoint, Territory]) },
  );
  const byTerritory = new Map<string, TerritoryPrices>();
  for (const { id, attributes, relationships } of data) {
    const territory = relationships.territory?.data?.id;
    const pricePointId = relationships.subscriptionPricePoint?.data?.id;
    if (
      territory === undefined ||
      pricePointId === undefined ||
      (attributes.planType ?? UPFRONT) !== UPFRONT
    ) {
      continue;
    }
    const point = findIncluded(included, 'subscriptionPricePoints', { id: pricePointId });
    const entry = {
      id,
      territory,
      pricePointId,
      customerPrice: point?.attributes.customerPrice ?? null,
      startDate: attributes.startDate ?? null,
    };
    const prices = byTerritory.get(territory) ?? { current: undefined, scheduled: [] };
    if (entry.startDate !== null && entry.startDate > today) {
      prices.scheduled.push(entry);
    } else if (
      prices.current === undefined ||
      (entry.startDate ?? '') > (prices.current.startDate ?? '')
    ) {
      prices.current = entry;
    }
    byTerritory.set(territory, prices);
  }
  return byTerritory;
}

export type OfferEntry = {
  id: string;
  territory: string;
  offerMode: string | null;
  duration: string | null;
  numberOfPeriods: number | null;
  startDate: string | null;
  endDate: string | null;
};

// 終わった導入オファーは読まない
export async function readIntroductoryOffers(
  client: AscClient,
  subscriptionId: string,
  today: string,
): Promise<OfferEntry[]> {
  const { data } = await client.getAll(
    `/v1/subscriptions/${subscriptionId}/introductoryOffers`,
    { ...sparseFields(IntroductoryOffer), limit: '200' },
    { data: IntroductoryOffer },
  );
  return data.flatMap(({ id, attributes, relationships }) => {
    const territory = relationships.territory?.data?.id;
    const endDate = attributes.endDate ?? null;
    if (territory === undefined || (endDate !== null && endDate < today)) {
      return [];
    }
    return [
      {
        id,
        territory,
        offerMode: attributes.offerMode ?? null,
        duration: attributes.duration ?? null,
        numberOfPeriods: attributes.numberOfPeriods ?? null,
        startDate: attributes.startDate ?? null,
        endDate,
      },
    ];
  });
}

// 日付は YYYY-MM-DD で比べる。Apple は、価格とオファーの日付をこの形で返す
export function dateOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
