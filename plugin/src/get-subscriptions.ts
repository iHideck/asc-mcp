import { findApp, type AppSummary } from './apps.ts';
import type { AscClient } from './client.ts';
import {
  dateOf,
  GROUP_METADATA,
  listGroups,
  listSubscriptions,
  readIntroductoryOffers,
  readLocalizations,
  readReviewScreenshot,
  readUpfrontAvailability,
  readUpfrontPrices,
  SUBSCRIPTION_METADATA,
  type LocalizationsState,
  type OfferEntry,
  type SubscriptionResource,
} from './subscriptions.ts';

export type SubscriptionStatus = {
  productId: string;
  referenceName: string | null;
  subscriptionPeriod: string | null;
  familySharable: boolean | null;
  state: string | null;
  groupLevel: number | null;
  reviewNote: string | null;
  localizations: LocalizationsState;
  reviewScreenshot: { fileName: string | null; state: string | null } | null;
  availability: { availableInNewTerritories: boolean | null; territories: string[] } | null;
  prices: Record<string, string | null>;
  scheduledPrices: { territory: string; customerPrice: string | null; startDate: string | null }[];
  introductoryOffers: {
    offerMode: string | null;
    duration: string | null;
    numberOfPeriods: number | null;
    startDate: string | null;
    endDate: string | null;
    territories: string[];
  }[];
};

export type GroupStatus = {
  referenceName: string;
  localizations: LocalizationsState;
  subscriptions: SubscriptionStatus[];
};

export type SubscriptionsStatus = { app: AppSummary; groups: GroupStatus[] };

export async function getSubscriptions(
  client: AscClient,
  request: { bundleId: string; productId?: string | undefined },
  now: () => number = Date.now,
): Promise<SubscriptionsStatus> {
  const app = await findApp(client, request.bundleId);
  const today = dateOf(now());
  const groups = await listGroups(client, app.appleId);
  const statuses = await Promise.all(
    groups.map(async (group) => {
      const [localizations, subscriptions] = await Promise.all([
        readLocalizations(client, GROUP_METADATA, group.id),
        listSubscriptions(client, group.id, request.productId),
      ]);
      return {
        referenceName: group.referenceName,
        localizations,
        subscriptions: await Promise.all(
          subscriptions.map((subscription) => readStatus(client, subscription, today)),
        ),
      };
    }),
  );
  return {
    app,
    groups:
      request.productId === undefined
        ? statuses
        : statuses.filter(({ subscriptions }) => subscriptions.length > 0),
  };
}

async function readStatus(
  client: AscClient,
  { id, attributes }: SubscriptionResource,
  today: string,
): Promise<SubscriptionStatus> {
  const [localizations, screenshot, availability, prices, offers] = await Promise.all([
    readLocalizations(client, SUBSCRIPTION_METADATA, id),
    readReviewScreenshot(client, id),
    readUpfrontAvailability(client, id),
    readUpfrontPrices(client, id, today),
    readIntroductoryOffers(client, id, today),
  ]);
  const territories = [...prices.keys()].sort();
  return {
    productId: attributes.productId,
    referenceName: attributes.name ?? null,
    subscriptionPeriod: attributes.subscriptionPeriod ?? null,
    familySharable: attributes.familySharable ?? null,
    state: attributes.state ?? null,
    groupLevel: attributes.groupLevel ?? null,
    reviewNote: attributes.reviewNote ?? null,
    localizations,
    reviewScreenshot:
      screenshot === null
        ? null
        : {
            fileName: screenshot.attributes.fileName ?? null,
            state: screenshot.attributes.assetDeliveryState?.state ?? null,
          },
    availability:
      availability === null
        ? null
        : {
            availableInNewTerritories: availability.availableInNewTerritories,
            territories: availability.territories,
          },
    prices: Object.fromEntries(
      territories.map((territory) => [
        territory,
        prices.get(territory)?.current?.customerPrice ?? null,
      ]),
    ),
    scheduledPrices: territories.flatMap((territory) =>
      (prices.get(territory)?.scheduled ?? []).map(({ customerPrice, startDate }) => ({
        territory,
        customerPrice,
        startDate,
      })),
    ),
    introductoryOffers: groupOffers(offers),
  };
}

// 同じ中身のオファーは国ごとに1つずつあるので、中身ごとにまとめる
function groupOffers(offers: OfferEntry[]): SubscriptionStatus['introductoryOffers'] {
  const groups = new Map<string, SubscriptionStatus['introductoryOffers'][number]>();
  for (const { territory, offerMode, duration, numberOfPeriods, startDate, endDate } of offers) {
    const key = JSON.stringify([offerMode, duration, numberOfPeriods, startDate, endDate]);
    const group = groups.get(key) ?? {
      offerMode,
      duration,
      numberOfPeriods,
      startDate,
      endDate,
      territories: [],
    };
    group.territories.push(territory);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    territories: group.territories.sort(),
  }));
}
