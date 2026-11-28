import { z } from 'zod';
import type { AppSummary } from './apps.ts';
import { findIncluded, sparseFields, type AscClient } from './client.ts';
import { trackProgress } from './progress.ts';
import {
  dateOf,
  listTerritoryIds,
  PricePoint,
  readIntroductoryOffers,
  readUpfrontAvailability,
  readUpfrontPrices,
  requireSubscription,
  UPFRONT,
  type OfferEntry,
  type PlanAvailabilityState,
} from './subscriptions.ts';

const Territory = z.object({
  type: z.literal('territories'),
  id: z.string(),
  attributes: z.object({ currency: z.string().nullish() }),
});

export const OFFER_DURATIONS = [
  'THREE_DAYS',
  'ONE_WEEK',
  'TWO_WEEKS',
  'ONE_MONTH',
  'TWO_MONTHS',
  'THREE_MONTHS',
  'SIX_MONTHS',
  'ONE_YEAR',
] as const;
export type OfferDuration = (typeof OFFER_DURATIONS)[number];

const FREE_TRIAL = 'FREE_TRIAL';

export type SetSubscriptionPriceRequest = {
  bundleId: string;
  productId: string;
  baseTerritory: string;
  price: string;
  territories?: string[] | undefined;
  availableInNewTerritories?: boolean | undefined;
  preserveCurrentPrice?: boolean | undefined;
};

export type SetSubscriptionPriceResult = {
  app: AppSummary;
  productId: string;
  baseTerritory: string;
  price: string;
  territories: { before: string[]; after: string[] };
  changedPrices: string[];
  unchangedPrices: number;
  warnings: string[];
};

export async function setSubscriptionPrice(
  client: AscClient,
  request: SetSubscriptionPriceRequest,
  now: () => number = Date.now,
): Promise<SetSubscriptionPriceResult> {
  const { app, subscription } = await requireSubscription(
    client,
    request.bundleId,
    request.productId,
  );
  const allTerritories = await listTerritoryIds(client);
  const wanted = [...new Set(request.territories ?? allTerritories)];
  const unknown = [request.baseTerritory, ...wanted].filter((id) => !allTerritories.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown territory IDs: ${[...new Set(unknown)].join(', ')}. A territory ID has three letters, such as JPN or USA. Nothing was changed.`,
    );
  }
  if (!wanted.includes(request.baseTerritory)) {
    throw new Error(
      `Include the base territory ${request.baseTerritory} in territories. Nothing was changed.`,
    );
  }
  const base = await findBasePricePoint(client, subscription.id, request);
  const equalized = await equalizedPricePoints(client, base.id);
  equalized.set(request.baseTerritory, base.id);
  const today = dateOf(now());
  const availability = await readUpfrontAvailability(client, subscription.id);
  const prices = await readUpfrontPrices(client, subscription.id, today);
  const progress = trackProgress();
  const warnings: string[] = [];

  await setTerritories(client, progress, subscription.id, availability, wanted, request);

  const changedPrices: string[] = [];
  let unchangedPrices = 0;
  // 売らない国にも価格が要る。無い国があると、審査に出せない（IAP_SUBMISSION_NOT_ALLOWED_MISSING_PRICING_DATA）
  for (const territory of [...allTerritories].sort()) {
    const pricePointId = equalized.get(territory);
    if (pricePointId === undefined) {
      warnings.push(
        `Apple returned no equalized price for ${territory}, so its price was not set.`,
      );
      continue;
    }
    const current = prices.get(territory);
    const scheduled = current?.scheduled ?? [];
    if (current?.current?.pricePointId === pricePointId && scheduled.length === 0) {
      unchangedPrices += 1;
      continue;
    }
    // 予約した価格は変えられないので、消してから入れ直す
    for (const entry of scheduled) {
      await progress.write(
        `removing the price scheduled for ${entry.startDate ?? ''} in ${territory}`,
        `Removed the price scheduled in ${territory}`,
        () => client.remove('subscriptionPrices', entry.id),
      );
    }
    if (current?.current?.pricePointId !== pricePointId) {
      await progress.write(
        `setting the price in ${territory}`,
        `Set the price in ${territory}`,
        () =>
          client.create(
            'subscriptionPrices',
            {
              startDate: null,
              planType: UPFRONT,
              ...(request.preserveCurrentPrice === undefined
                ? {}
                : { preserveCurrentPrice: request.preserveCurrentPrice }),
            },
            {
              subscription: { type: 'subscriptions', id: subscription.id },
              subscriptionPricePoint: { type: 'subscriptionPricePoints', id: pricePointId },
            },
          ),
      );
    }
    changedPrices.push(territory);
  }

  const after = await progress.read('reading the territories again', () =>
    readUpfrontAvailability(client, subscription.id),
  );
  return {
    app,
    productId: request.productId,
    baseTerritory: request.baseTerritory,
    price: request.price,
    territories: { before: availability?.territories ?? [], after: after?.territories ?? [] },
    changedPrices,
    unchangedPrices,
    warnings,
  };
}

async function setTerritories(
  client: AscClient,
  progress: ReturnType<typeof trackProgress>,
  subscriptionId: string,
  availability: PlanAvailabilityState | null,
  wanted: string[],
  request: SetSubscriptionPriceRequest,
): Promise<void> {
  const territories = [...wanted].sort().map((id) => ({ type: 'territories', id }));
  if (availability === null) {
    await progress.write(
      `making the subscription available in ${wanted.length} territories`,
      `Made the subscription available in ${wanted.length} territories`,
      () =>
        client.create(
          'subscriptionPlanAvailabilities',
          {
            planType: UPFRONT,
            ...(request.availableInNewTerritories === undefined
              ? {}
              : { availableInNewTerritories: request.availableInNewTerritories }),
          },
          {
            subscription: { type: 'subscriptions', id: subscriptionId },
            availableTerritories: territories,
          },
        ),
    );
    return;
  }
  const same =
    availability.territories.length === wanted.length &&
    wanted.every((id) => availability.territories.includes(id));
  if (!same) {
    await progress.write(
      `changing the territories of the subscription to ${wanted.length} territories`,
      `Changed the territories of the subscription to ${wanted.length} territories`,
      () =>
        client.setRelationship(
          'subscriptionPlanAvailabilities',
          availability.id,
          'availableTerritories',
          territories,
        ),
    );
  }
  if (
    request.availableInNewTerritories !== undefined &&
    request.availableInNewTerritories !== availability.availableInNewTerritories
  ) {
    const value = request.availableInNewTerritories;
    await progress.write(
      'changing whether the subscription becomes available in new territories',
      'Changed whether the subscription becomes available in new territories',
      () =>
        client.update('subscriptionPlanAvailabilities', availability.id, {
          availableInNewTerritories: value,
        }),
    );
  }
}

async function findBasePricePoint(
  client: AscClient,
  subscriptionId: string,
  { baseTerritory, price }: SetSubscriptionPriceRequest,
): Promise<{ id: string; customerPrice: string }> {
  const { data } = await client.getAll(
    `/v1/subscriptions/${subscriptionId}/pricePoints`,
    {
      'fields[subscriptionPricePoints]': 'customerPrice',
      'filter[territory]': baseTerritory,
      limit: '200',
    },
    { data: PricePoint.omit({ relationships: true }) },
  );
  const wanted = Number(price);
  const match = data.find(({ attributes }) => Number(attributes.customerPrice) === wanted);
  if (match === undefined) {
    const nearest = data
      .map(({ attributes }) => attributes.customerPrice)
      .sort((a, b) => Math.abs(Number(a) - wanted) - Math.abs(Number(b) - wanted))
      .slice(0, 5)
      .sort((a, b) => Number(a) - Number(b));
    throw new Error(
      `${baseTerritory} has no price point of ${price}. The nearest prices are ${nearest.join(', ')}. Nothing was changed.`,
    );
  }
  return { id: match.id, customerPrice: match.attributes.customerPrice };
}

// 基準の国の価格に近い、ほかの国の価格（為替と税を踏まえて Apple が決めたもの）
async function equalizedPricePoints(
  client: AscClient,
  basePricePointId: string,
): Promise<Map<string, string>> {
  const { data, included } = await client.getAll(
    `/v1/subscriptionPricePoints/${basePricePointId}/equalizations`,
    { ...sparseFields(PricePoint, Territory), limit: '200' },
    { data: PricePoint, included: Territory },
  );
  return new Map(
    data.flatMap(({ id, relationships }) => {
      const territory = findIncluded(included, 'territories', relationships.territory?.data)?.id;
      return territory === undefined ? [] : [[territory, id] as const];
    }),
  );
}

export type SetIntroductoryOfferRequest = {
  bundleId: string;
  productId: string;
  duration: OfferDuration;
  territories?: string[] | undefined;
};

export type SetIntroductoryOfferResult = {
  app: AppSummary;
  productId: string;
  offer: { offerMode: string; duration: OfferDuration };
  changedTerritories: string[];
  unchangedTerritories: number;
};

// 無料期間だけを扱う。国ごとに1つずつ作る（今のオファーと、先のオファーを1つずつ持てる）
export async function setIntroductoryOffer(
  client: AscClient,
  request: SetIntroductoryOfferRequest,
  now: () => number = Date.now,
): Promise<SetIntroductoryOfferResult> {
  const { app, subscription } = await requireSubscription(
    client,
    request.bundleId,
    request.productId,
  );
  const availability = await readUpfrontAvailability(client, subscription.id);
  if (availability === null || availability.territories.length === 0) {
    throw new Error(
      `The subscription ${request.productId} is not available in any territory. Set the price and territories with set_subscription_price first. Nothing was changed.`,
    );
  }
  const wanted = [...new Set(request.territories ?? availability.territories)];
  const outside = wanted.filter((id) => !availability.territories.includes(id));
  if (outside.length > 0) {
    throw new Error(
      `The subscription is not available in ${outside.join(', ')}. Add them with set_subscription_price first. Nothing was changed.`,
    );
  }
  const today = dateOf(now());
  const offers = await readIntroductoryOffers(client, subscription.id, today);
  const progress = trackProgress();
  const changedTerritories: string[] = [];
  let unchangedTerritories = 0;
  for (const territory of [...wanted].sort()) {
    const existing = offers.filter((offer) => offer.territory === territory);
    if (
      existing.length === 1 &&
      existing[0] !== undefined &&
      isSameOffer(existing[0], request, today)
    ) {
      unchangedTerritories += 1;
      continue;
    }
    for (const offer of existing) {
      await progress.write(
        `removing the current introductory offer in ${territory}`,
        `Removed the introductory offer in ${territory}`,
        () => client.remove('subscriptionIntroductoryOffers', offer.id),
      );
    }
    await progress.write(
      `adding the free trial in ${territory}`,
      `Added the free trial in ${territory}`,
      () =>
        client.create(
          'subscriptionIntroductoryOffers',
          { offerMode: FREE_TRIAL, duration: request.duration, numberOfPeriods: 1 },
          {
            subscription: { type: 'subscriptions', id: subscription.id },
            territory: { type: 'territories', id: territory },
          },
        ),
    );
    changedTerritories.push(territory);
  }
  return {
    app,
    productId: request.productId,
    offer: { offerMode: FREE_TRIAL, duration: request.duration },
    changedTerritories,
    unchangedTerritories,
  };
}

// 終わりの日の無い、もう始まっている無料期間なら、同じとみなす
function isSameOffer(
  offer: OfferEntry,
  request: SetIntroductoryOfferRequest,
  today: string,
): boolean {
  return (
    offer.offerMode === FREE_TRIAL &&
    offer.duration === request.duration &&
    offer.numberOfPeriods === 1 &&
    (offer.startDate === null || offer.startDate <= today) &&
    offer.endDate === null
  );
}
