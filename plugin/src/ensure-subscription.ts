import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import type { AscClient, Attributes } from './client.ts';
import { trackProgress, type Progress } from './progress.ts';
import { DISPLAY_TYPES, imageSize, POLL_ROUNDS } from './screenshots.ts';
import {
  findSubscription,
  GROUP_METADATA,
  listGroups,
  listSubscriptions,
  readLocalizations,
  readReviewScreenshot,
  SUBSCRIPTION_METADATA,
  syncLocalizations,
  type GroupSummary,
  type LocalizationsState,
  type ReviewScreenshotResource,
  type SubscriptionPeriod,
  type SubscriptionResource,
} from './subscriptions.ts';

const POLL_INTERVAL_MS = 5_000;

export type EnsureSubscriptionRequest = {
  bundleId: string;
  groupReferenceName: string;
  groupLocalizations?: { locale: string; name: string; customAppName?: string | undefined }[];
  productId: string;
  referenceName?: string | undefined;
  subscriptionPeriod?: SubscriptionPeriod | undefined;
  familySharable?: boolean | undefined;
  reviewNote?: string | undefined;
  localizations?: { locale: string; name: string; description?: string | undefined }[];
  reviewScreenshot?: string | undefined;
};

export type SubscriptionState = {
  groupReferenceName: string;
  groupLocalizations: LocalizationsState;
  productId: string;
  referenceName: string | null;
  subscriptionPeriod: string | null;
  familySharable: boolean | null;
  state: string | null;
  reviewNote: string | null;
  localizations: LocalizationsState;
  reviewScreenshot: { fileName: string | null; state: string | null } | null;
};

export type EnsureSubscriptionResult = {
  app: AppSummary;
  before: SubscriptionState | null;
  after: SubscriptionState;
  warnings: string[];
};

type Wait = (ms: number) => Promise<unknown>;

type ScreenshotFile = { fileName: string; bytes: Buffer<ArrayBuffer>; checksum: string };

const ReservedScreenshot = z.object({
  type: z.literal('subscriptionAppStoreReviewScreenshots'),
  id: z.string(),
  attributes: z.object({
    uploadOperations: z.array(
      z.object({
        method: z.string(),
        url: z.url(),
        offset: z.number(),
        length: z.number(),
        requestHeaders: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .nullish()
          .transform((headers) => headers ?? []),
      }),
    ),
  }),
});

const wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureSubscription(
  client: AscClient,
  request: EnsureSubscriptionRequest,
  pause: Wait = wait,
): Promise<EnsureSubscriptionResult> {
  const screenshot =
    request.reviewScreenshot === undefined
      ? undefined
      : await readScreenshotFile(request.reviewScreenshot);
  const app = await findApp(client, request.bundleId);
  const groups = await listGroups(client, app.appleId);
  const found = await findSubscription(client, groups, request.productId);
  const requestedGroup = groups.find(
    ({ referenceName }) => referenceName === request.groupReferenceName,
  );
  if (found !== undefined && found.group.id !== requestedGroup?.id) {
    throw new Error(
      `The subscription ${request.productId} is in the group "${found.group.referenceName}", not "${request.groupReferenceName}". Pass groupReferenceName "${found.group.referenceName}". Nothing was changed.`,
    );
  }
  if (
    found === undefined &&
    (request.referenceName === undefined || request.subscriptionPeriod === undefined)
  ) {
    throw new Error(
      `No subscription has the product ID ${request.productId}. To create it, also pass referenceName and subscriptionPeriod. Nothing was changed.`,
    );
  }
  const before =
    found === undefined ? null : await readState(client, found.group, found.subscription);
  const progress = trackProgress();

  const group =
    requestedGroup ??
    ({
      id: await progress.write(
        `creating the subscription group "${request.groupReferenceName}"`,
        `Created the subscription group "${request.groupReferenceName}"`,
        () =>
          client.create(
            'subscriptionGroups',
            { referenceName: request.groupReferenceName },
            { app: { type: 'apps', id: app.appleId } },
          ),
      ),
      referenceName: request.groupReferenceName,
    } satisfies GroupSummary);

  if (request.groupLocalizations !== undefined) {
    await syncLocalizations(
      client,
      progress,
      GROUP_METADATA,
      group.id,
      request.groupLocalizations.map(({ locale, name, customAppName }) => ({
        locale,
        name,
        ...(customAppName === undefined ? {} : { customAppName }),
      })),
    );
  }

  const subscriptionId =
    found === undefined
      ? await progress.write(
          `creating the subscription ${request.productId}`,
          `Created the subscription ${request.productId}`,
          () =>
            client.create(
              'subscriptions',
              {
                productId: request.productId,
                name: request.referenceName ?? request.productId,
                ...productChanges(undefined, request),
              },
              { group: { type: 'subscriptionGroups', id: group.id } },
            ),
        )
      : found.subscription.id;
  if (found !== undefined) {
    const changes = productChanges(found.subscription, request);
    if (Object.keys(changes).length > 0) {
      await progress.write(
        `changing ${Object.keys(changes).join(', ')} of the subscription ${request.productId}`,
        `Changed ${Object.keys(changes).join(', ')} of the subscription ${request.productId}`,
        () => client.update('subscriptions', subscriptionId, changes),
      );
    }
  }

  if (request.localizations !== undefined) {
    await syncLocalizations(
      client,
      progress,
      SUBSCRIPTION_METADATA,
      subscriptionId,
      request.localizations.map(({ locale, name, description }) => ({
        locale,
        name,
        ...(description === undefined ? {} : { description }),
      })),
    );
  }

  const warnings: string[] = [];
  if (screenshot !== undefined) {
    const pending = await replaceReviewScreenshot(
      client,
      progress,
      subscriptionId,
      screenshot,
      pause,
    );
    if (pending) {
      warnings.push(
        'Apple is still processing the review screenshot. Check its state later with get_subscriptions.',
      );
    }
  }

  const after = await progress.read('reading the subscription again', async () => {
    const subscription = (await listSubscriptions(client, group.id, request.productId)).find(
      ({ id }) => id === subscriptionId,
    );
    if (subscription === undefined) {
      throw new Error(`Could not read the subscription ${request.productId} again.`);
    }
    return readState(client, group, subscription);
  });
  warnings.push(...missingItems(after));
  return { app, before, after, warnings };
}

function productChanges(
  current: SubscriptionResource | undefined,
  request: EnsureSubscriptionRequest,
): Attributes {
  const attributes = current?.attributes;
  const wanted: Attributes = {
    ...(current === undefined || request.referenceName === undefined
      ? {}
      : { name: request.referenceName }),
    ...(request.subscriptionPeriod === undefined
      ? {}
      : { subscriptionPeriod: request.subscriptionPeriod }),
    ...(request.familySharable === undefined ? {} : { familySharable: request.familySharable }),
    ...(request.reviewNote === undefined ? {} : { reviewNote: request.reviewNote }),
  };
  return Object.fromEntries(
    Object.entries(wanted).filter(
      ([name, value]) => attributes?.[name as keyof typeof attributes] !== value,
    ),
  );
}

export async function readState(
  client: AscClient,
  group: GroupSummary,
  subscription: SubscriptionResource,
): Promise<SubscriptionState> {
  const [groupLocalizations, localizations, screenshot] = await Promise.all([
    readLocalizations(client, GROUP_METADATA, group.id),
    readLocalizations(client, SUBSCRIPTION_METADATA, subscription.id),
    readReviewScreenshot(client, subscription.id),
  ]);
  const { attributes } = subscription;
  return {
    groupReferenceName: group.referenceName,
    groupLocalizations,
    productId: attributes.productId,
    referenceName: attributes.name ?? null,
    subscriptionPeriod: attributes.subscriptionPeriod ?? null,
    familySharable: attributes.familySharable ?? null,
    state: attributes.state ?? null,
    reviewNote: attributes.reviewNote ?? null,
    localizations,
    reviewScreenshot:
      screenshot === null
        ? null
        : {
            fileName: screenshot.attributes.fileName ?? null,
            state: screenshot.attributes.assetDeliveryState?.state ?? null,
          },
  };
}

function missingItems(state: SubscriptionState): string[] {
  return [
    state.groupLocalizations.localizations.length === 0
      ? 'The subscription group has no localized display name. Pass groupLocalizations.'
      : undefined,
    state.localizations.localizations.length === 0
      ? 'The subscription has no localized display name and description. Pass localizations.'
      : undefined,
    state.reviewScreenshot === null
      ? 'The subscription has no review screenshot. App Review needs one. Pass reviewScreenshot.'
      : undefined,
  ].filter((warning) => warning !== undefined);
}

// 審査用のスクリーンショットは、アプリが対応する画面写真の大きさのどれかに合わせる
const SCREENSHOT_SIZES = new Set(Object.values(DISPLAY_TYPES).flatMap(({ sizes }) => sizes));

async function readScreenshotFile(path: string): Promise<ScreenshotFile> {
  const problem = (reason: string) =>
    new Error(`Cannot use the review screenshot ${path}: ${reason}. Nothing was changed.`);
  if (!isAbsolute(path)) {
    throw problem('pass an absolute path');
  }
  let bytes: Buffer<ArrayBuffer>;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : String(error);
    throw problem(code === 'ENOENT' ? 'the file does not exist' : `cannot read the file (${code})`);
  }
  const size = imageSize(bytes);
  if (size === undefined) {
    throw problem('cannot read the size as a PNG or JPEG image');
  }
  if (!SCREENSHOT_SIZES.has(size)) {
    throw problem(
      `${size} is not a screenshot size of any display type that replace_screenshots accepts`,
    );
  }
  return {
    fileName: basename(path),
    bytes,
    checksum: createHash('md5').update(bytes).digest('hex'),
  };
}

// 同じ写真（MD5 が同じ）なら何もしない。違えば、いまの写真を消してから上げる。戻り値は、処理がまだ終わっていないか
async function replaceReviewScreenshot(
  client: AscClient,
  progress: Progress,
  subscriptionId: string,
  file: ScreenshotFile,
  pause: Wait,
): Promise<boolean> {
  const current = await readReviewScreenshot(client, subscriptionId);
  if (current?.attributes.sourceFileChecksum === file.checksum) {
    return false;
  }
  if (current !== null) {
    await progress.write(
      'removing the current review screenshot',
      'Removed the current review screenshot',
      () => client.remove('subscriptionAppStoreReviewScreenshots', current.id),
    );
  }
  const reserved = await progress.write(
    `reserving the review screenshot ${file.fileName}`,
    `Reserved the review screenshot ${file.fileName}`,
    () =>
      client.createResource(
        'subscriptionAppStoreReviewScreenshots',
        { fileName: file.fileName, fileSize: file.bytes.length },
        { subscription: { type: 'subscriptions', id: subscriptionId } },
        ReservedScreenshot,
      ),
  );
  await progress.write(
    `uploading the review screenshot ${file.fileName}`,
    `Uploaded the review screenshot ${file.fileName}`,
    async () => {
      for (const operation of reserved.attributes.uploadOperations) {
        await client.upload(operation, file.bytes);
      }
      await client.update('subscriptionAppStoreReviewScreenshots', reserved.id, {
        uploaded: true,
        sourceFileChecksum: file.checksum,
      });
    },
  );
  for (let round = 1; ; round += 1) {
    const screenshot = await progress.read('reading the review screenshot', () =>
      readReviewScreenshot(client, subscriptionId),
    );
    const state = screenshot?.attributes.assetDeliveryState?.state;
    if (state === 'FAILED') {
      throw new Error(
        `Apple did not accept the review screenshot ${file.fileName}: ${describeErrors(screenshot)}. Fix it, then make the same call again.`,
      );
    }
    if (state === 'COMPLETE') {
      return false;
    }
    if (round === POLL_ROUNDS) {
      return true;
    }
    await pause(POLL_INTERVAL_MS);
  }
}

function describeErrors(screenshot: ReviewScreenshotResource | null): string {
  const reasons = (screenshot?.attributes.assetDeliveryState?.errors ?? []).map(
    ({ code, description }) => [code, description].filter(Boolean).join(': '),
  );
  return reasons.length === 0 ? 'no reason was returned' : reasons.join(', ');
}
