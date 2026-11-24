import { jsonResponse, page, resource } from './fake-api.ts';

export const APP_ID = '6754036371';
export const BUNDLE_ID = 'com.ihideck.snoretalk';
export const PRODUCT_ID = 'com.ihideck.snoretalk.monthly';
export const GROUPS = `/v1/apps/${APP_ID}/subscriptionGroups`;
export const UPLOAD = 'https://store-001.blobstore.apple.com';

export function app() {
  return page([resource('apps', APP_ID, { name: 'SnoreTalk', bundleId: BUNDLE_ID })]);
}

export function group(id = 'g1', referenceName = 'Premium') {
  return resource('subscriptionGroups', id, { referenceName });
}

type SubscriptionFields = {
  name?: string;
  subscriptionPeriod?: string;
  familySharable?: boolean;
  reviewNote?: string | null;
  state?: string;
};

export function subscription(id = 's1', fields: SubscriptionFields = {}) {
  return resource('subscriptions', id, {
    name: fields.name ?? 'Monthly',
    productId: PRODUCT_ID,
    familySharable: fields.familySharable ?? false,
    state: fields.state ?? 'READY_TO_SUBMIT',
    subscriptionPeriod: fields.subscriptionPeriod ?? 'ONE_MONTH',
    reviewNote: fields.reviewNote ?? null,
    groupLevel: 1,
  });
}

export function groupVersion(id: string, version: number, state: string) {
  return resource('subscriptionGroupVersions', id, { version, state });
}

export function subscriptionVersion(id: string, version: number, state: string) {
  return resource('subscriptionVersions', id, { version, state });
}

export function groupLocalization(
  id: string,
  locale: string,
  name: string,
  customAppName: string | null = null,
) {
  return resource('subscriptionGroupLocalizations', id, { locale, name, customAppName });
}

export function subscriptionLocalization(
  id: string,
  locale: string,
  name: string,
  description: string | null = null,
) {
  return resource('subscriptionLocalizations', id, { locale, name, description });
}

export function reviewScreenshot(id: string, checksum: string | null, state: string) {
  return resource('subscriptionAppStoreReviewScreenshots', id, {
    fileName: 'review.png',
    sourceFileChecksum: checksum,
    assetDeliveryState: { state, errors: [] },
  });
}

export function none() {
  return jsonResponse(200, { data: null });
}

export function reserved(id: string, size: number) {
  return jsonResponse(201, {
    data: resource('subscriptionAppStoreReviewScreenshots', id, {
      uploadOperations: [
        {
          method: 'PUT',
          url: `${UPLOAD}/${id}/part1`,
          offset: 0,
          length: size,
          requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
        },
      ],
    }),
  });
}

export function territory(id: string) {
  return resource('territories', id, { currency: null });
}

export function planAvailability(
  id: string,
  planType = 'UPFRONT',
  availableInNewTerritories = true,
) {
  return resource('subscriptionPlanAvailabilities', id, { planType, availableInNewTerritories });
}

// 価格の点の id は、Apple と同じく、国と段を入れた形にする
export function pricePointId(territoryId: string, tier: number): string {
  return `pp-${territoryId}-${tier}`;
}

export function pricePoint(territoryId: string, tier: number, customerPrice: string) {
  return resource(
    'subscriptionPricePoints',
    pricePointId(territoryId, tier),
    { customerPrice },
    { territory: `territories:${territoryId}` },
  );
}

export function price(
  id: string,
  territoryId: string,
  tier: number,
  startDate: string | null,
  planType: string | null = 'UPFRONT',
) {
  return resource(
    'subscriptionPrices',
    id,
    { startDate, planType },
    {
      territory: `territories:${territoryId}`,
      subscriptionPricePoint: `subscriptionPricePoints:${pricePointId(territoryId, tier)}`,
    },
  );
}

export function offer(
  id: string,
  territoryId: string,
  fields: {
    duration?: string;
    offerMode?: string;
    startDate?: string | null;
    endDate?: string | null;
    targetSubscriptionPlanType?: string | null;
  } = {},
) {
  return resource(
    'subscriptionIntroductoryOffers',
    id,
    {
      startDate: fields.startDate ?? null,
      endDate: fields.endDate ?? null,
      duration: fields.duration ?? 'ONE_WEEK',
      offerMode: fields.offerMode ?? 'FREE_TRIAL',
      numberOfPeriods: 1,
      targetSubscriptionPlanType: fields.targetSubscriptionPlanType ?? null,
    },
    { territory: `territories:${territoryId}` },
  );
}
