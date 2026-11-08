import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { sparseFields, type AscClient } from './client.ts';
import { readVersionLocalizations } from './localizations.ts';
import { trackProgress } from './progress.ts';
import { listVersions, pickEditableVersion } from './versions.ts';

// Apple の「Screenshot specifications」の区分ごとの、受け付ける写真の大きさ（幅x高さ。縦向きと横向き）
export const DISPLAY_TYPES = {
  APP_IPHONE_67: {
    label: 'iPhone with Dynamic Island (large display)',
    sizes: ['1260x2736', '2736x1260', '1290x2796', '2796x1290', '1320x2868', '2868x1320'],
  },
  APP_IPHONE_65: {
    label: 'iPhone with Face ID (large display)',
    sizes: ['1284x2778', '2778x1284', '1242x2688', '2688x1242'],
  },
  APP_IPHONE_61: {
    label: 'iPhone with Dynamic Island (medium display)',
    sizes: ['1179x2556', '2556x1179', '1206x2622', '2622x1206'],
  },
  APP_IPHONE_58: {
    label: 'iPhone with Face ID (medium display)',
    sizes: ['1170x2532', '2532x1170', '1125x2436', '2436x1125', '1080x2340', '2340x1080'],
  },
  APP_IPHONE_55: {
    label: 'iPhone with Home Button (large display)',
    sizes: ['1242x2208', '2208x1242'],
  },
  APP_IPHONE_47: {
    label: 'iPhone with Home Button (medium display)',
    sizes: ['750x1334', '1334x750'],
  },
  APP_IPHONE_40: {
    label: 'iPhone with Home Button (4" display)',
    sizes: ['640x1096', '640x1136', '1136x600', '1136x640'],
  },
  APP_IPHONE_35: {
    label: 'iPhone with Home Button (3.5" display)',
    sizes: ['640x920', '640x960', '960x600', '960x640'],
  },
  APP_IPAD_PRO_3GEN_129: {
    label: 'iPad 13" display',
    sizes: ['2064x2752', '2752x2064', '2048x2732', '2732x2048'],
  },
  APP_IPAD_PRO_129: {
    label: 'iPad 12.9" display',
    sizes: ['2048x2732', '2732x2048'],
  },
  APP_IPAD_PRO_3GEN_11: {
    label: 'iPad 11" display',
    sizes: [
      '1488x2266',
      '2266x1488',
      '1512x2316',
      '2316x1512',
      '1668x2420',
      '2420x1668',
      '1668x2388',
      '2388x1668',
      '1640x2360',
      '2360x1640',
    ],
  },
  APP_IPAD_105: {
    label: 'iPad 10.5" display',
    sizes: ['1668x2224', '2224x1668'],
  },
  APP_IPAD_97: {
    label: 'iPad 9.7" display',
    sizes: [
      '1536x2008',
      '1536x2048',
      '2048x1496',
      '2048x1536',
      '768x1004',
      '768x1024',
      '1024x748',
      '1024x768',
    ],
  },
} satisfies Record<string, { label: string; sizes: string[] }>;

export type DisplayType = keyof typeof DISPLAY_TYPES;
export const DISPLAY_TYPE_NAMES = Object.keys(DISPLAY_TYPES) as [DisplayType, ...DisplayType[]];

export const MAX_SCREENSHOTS = 10;

const POLL_INTERVAL_MS = 5_000;
export const POLL_ROUNDS = 24;

const ScreenshotSet = z.object({
  type: z.literal('appScreenshotSets'),
  id: z.string(),
  attributes: z.object({ screenshotDisplayType: z.string() }),
});

const Screenshot = z.object({
  type: z.literal('appScreenshots'),
  id: z.string(),
  attributes: z.object({
    fileName: z.string().nullable(),
    sourceFileChecksum: z.string().nullable(),
    imageAsset: z.object({ width: z.number(), height: z.number() }).nullable(),
    assetDeliveryState: z
      .object({
        state: z.string(),
        errors: z
          .array(z.object({ code: z.string().nullish(), description: z.string().nullish() }))
          .nullish(),
      })
      .nullable(),
  }),
});

type ScreenshotResource = z.infer<typeof Screenshot>;

const ReservedScreenshot = z.object({
  type: z.literal('appScreenshots'),
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

type Wait = (ms: number) => Promise<unknown>;

type ScreenshotFile = { fileName: string; bytes: Buffer<ArrayBuffer>; checksum: string };

export type ReplaceScreenshotsRequest = {
  bundleId: string;
  versionString?: string | undefined;
  locale: string;
  displayType: DisplayType;
  files: string[];
};

type ScreenshotSummary = { fileName: string | null; size: string | null; state: string | null };

export type ReplaceScreenshotsResult = {
  app: AppSummary;
  versionString: string;
  locale: string;
  displayType: DisplayType;
  uploaded: string[];
  removed: string[];
  before: ScreenshotSummary[];
  after: ScreenshotSummary[];
  warnings: string[];
};

export async function replaceScreenshots(
  client: AscClient,
  request: ReplaceScreenshotsRequest,
  wait: Wait = sleep,
): Promise<ReplaceScreenshotsResult> {
  const { locale, displayType } = request;
  const files = await readScreenshotFiles(request.files, displayType);
  const app = await findApp(client, request.bundleId);
  const version = pickEditableVersion(
    await listVersions(client, app.appleId, 'IOS'),
    request.versionString,
  );
  const { versionString } = version.status;
  const localizationId = await findLocalization(client, version.id, versionString, locale);
  const existingSetId = await findScreenshotSet(client, localizationId, displayType);
  const before =
    existingSetId === undefined ? [] : await readSettledScreenshots(client, existingSetId, wait);
  const { slots, remove } = planReplacement(before, files);
  const missing = slots.flatMap(({ file, existing }) => (existing === undefined ? [file] : []));
  const uploadedIds = new Map<ScreenshotFile, string>();
  const result = (
    current: ScreenshotResource[],
    removed: ScreenshotResource[],
    pending: string[] = [],
  ): ReplaceScreenshotsResult => ({
    app,
    versionString,
    locale,
    displayType,
    uploaded: [...uploadedIds.keys()].map(({ fileName }) => fileName),
    removed: removed.map(nameOf),
    before: before.map(summarize),
    after: current.map(summarize),
    warnings:
      pending.length === 0
        ? []
        : [
            `Apple が、まだ写真（${pending.join('、')}）を処理しているので、ここで止めました。数分たってから同じ呼び出しをやり直すと、続きを行います。`,
          ],
  });
  const kept = slots.flatMap(({ existing }) => existing?.id ?? []);
  if (missing.length === 0 && remove.length === 0 && sameOrder(before, kept)) {
    return result(before, []);
  }
  const where = `版 ${versionString} の ${locale} の ${displayType} の欄`;
  const progress = trackProgress();
  const setId =
    existingSetId ??
    (await progress.write(`${where}を作る`, `${where}を作りました`, () =>
      client.create(
        'appScreenshotSets',
        { screenshotDisplayType: displayType },
        {
          appStoreVersionLocalization: { type: 'appStoreVersionLocalizations', id: localizationId },
        },
      ),
    ));
  const upload = async (targets: ScreenshotFile[]) => {
    for (const file of targets) {
      uploadedIds.set(
        file,
        await progress.write(
          `写真 ${file.fileName} を上げる`,
          `写真 ${file.fileName} を上げました`,
          () => uploadScreenshot(client, setId, file),
        ),
      );
    }
  };
  const settle = () =>
    progress.read('Apple が写真を処理し終えるのを待つ', () =>
      waitForUploads(client, setId, new Set(uploadedIds.values()), wait),
    );
  // 欄に入る分を先に上げ、Apple が受け付けたのを確かめてから、要らない写真を消す
  const room = Math.max(0, MAX_SCREENSHOTS - before.length);
  await upload(missing.slice(0, room));
  if (uploadedIds.size > 0 && remove.length > 0) {
    const { screenshots, pending } = await settle();
    if (pending.length > 0) {
      return result(screenshots, [], pending);
    }
  }
  for (const screenshot of remove) {
    const name = nameOf(screenshot);
    await progress.write(`写真 ${name} を消す`, `写真 ${name} を消しました`, () =>
      client.remove('appScreenshots', screenshot.id),
    );
  }
  await upload(missing.slice(room));
  const { screenshots, pending } = await settle();
  if (pending.length > 0) {
    return result(screenshots, remove, pending);
  }
  const order = slots.flatMap(({ file, existing }) => existing?.id ?? uploadedIds.get(file) ?? []);
  if (sameOrder(screenshots, order)) {
    return result(screenshots, remove);
  }
  await progress.write(`${where}の写真を、渡した順に並べる`, `${where}の写真を並べました`, () =>
    client.setRelationship(
      'appScreenshotSets',
      setId,
      'appScreenshots',
      order.map((id) => ({ type: 'appScreenshots', id })),
    ),
  );
  return result(
    await progress.read('並べたあとの写真を読む', () => readScreenshots(client, setId)),
    remove,
  );
}

async function readScreenshotFiles(
  paths: string[],
  displayType: DisplayType,
): Promise<ScreenshotFile[]> {
  const { label, sizes } = DISPLAY_TYPES[displayType];
  const checks = await Promise.all(paths.map((path) => checkFile(path, sizes)));
  const problems = checks.flatMap((check, index) =>
    'problem' in check ? [`- ${paths[index]}: ${check.problem}`] : [],
  );
  if (problems.length > 0) {
    throw new Error(
      [
        `次の写真は ${displayType}（${label}）の欄に入れられないので、何も変えていません。この欄が受け付ける大きさは ${sizes.join('・')} です。`,
        ...problems,
      ].join('\n'),
    );
  }
  return checks.flatMap((check) => ('file' in check ? [check.file] : []));
}

async function checkFile(
  path: string,
  sizes: string[],
): Promise<{ file: ScreenshotFile } | { problem: string }> {
  if (!isAbsolute(path)) {
    return { problem: '絶対パスで渡してください' };
  }
  let bytes: Buffer<ArrayBuffer>;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : String(error);
    return { problem: code === 'ENOENT' ? 'ファイルがありません' : `読めません（${code}）` };
  }
  const size = imageSize(bytes);
  if (size === undefined) {
    return { problem: 'PNG か JPEG の写真として、大きさを読めません' };
  }
  if (!sizes.includes(size)) {
    const fits = DISPLAY_TYPE_NAMES.filter((name) => DISPLAY_TYPES[name].sizes.includes(size));
    return {
      problem: `${size} は、この欄の大きさではありません${fits.length === 0 ? '' : `（${fits.join('・')} の欄の大きさです）`}`,
    };
  }
  // Apple は、上げたファイルの MD5 を sourceFileChecksum に返す。同じ写真かを、これで見分ける
  return {
    file: {
      fileName: basename(path),
      bytes,
      checksum: createHash('md5').update(bytes).digest('hex'),
    },
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageSize(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
    if (isStartOfFrame(bytes[offset + 1] ?? 0)) {
      return `${bytes.readUInt16BE(offset + 7)}x${bytes.readUInt16BE(offset + 5)}`;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

// SOF0〜SOF15 のうち、C4（ハフマンの表）・C8（予約）・CC（算術符号の表）は、大きさを持たない
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

async function findLocalization(
  client: AscClient,
  versionId: string,
  versionString: string,
  locale: string,
): Promise<string> {
  const localizations = await readVersionLocalizations(client, versionId);
  const found = localizations.find(({ attributes }) => attributes.locale === locale);
  if (found === undefined) {
    throw new Error(
      `版 ${versionString} に、言語 ${locale} はありません。ある言語は ${localizations.map(({ attributes }) => attributes.locale).join('、')} です。`,
    );
  }
  return found.id;
}

async function findScreenshotSet(
  client: AscClient,
  localizationId: string,
  displayType: DisplayType,
): Promise<string | undefined> {
  const { data } = await client.getAll(
    `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`,
    { ...sparseFields(ScreenshotSet), 'filter[screenshotDisplayType]': displayType },
    { data: ScreenshotSet },
  );
  return data.find(({ attributes }) => attributes.screenshotDisplayType === displayType)?.id;
}

async function readScreenshots(client: AscClient, setId: string): Promise<ScreenshotResource[]> {
  const { data } = await client.getAll(
    `/v1/appScreenshotSets/${setId}/appScreenshots`,
    sparseFields(Screenshot),
    { data: Screenshot },
  );
  return data;
}

// 前の呼び出しで上げた写真の処理が終わるのを待ってから比べる。待たないと、同じ写真を見分けられず、消して上げ直してしまう
async function readSettledScreenshots(
  client: AscClient,
  setId: string,
  wait: Wait,
): Promise<ScreenshotResource[]> {
  const screenshots = await pollScreenshots(client, setId, wait, isProcessing);
  const processing = screenshots
    .filter((screenshot) => stateOf(screenshot) === 'UPLOAD_COMPLETE')
    .map(nameOf);
  if (processing.length > 0) {
    throw new Error(
      `Apple が、まだ写真（${processing.join('、')}）を処理しているので、何も変えていません。数分たってから、同じ呼び出しをやり直してください。`,
    );
  }
  return screenshots;
}

// 処理が済んだ写真だけを残す。上げかけと、処理に失敗した写真は、消して上げ直す
function planReplacement(current: ScreenshotResource[], files: ScreenshotFile[]) {
  const reusable = current.filter((screenshot) => stateOf(screenshot) === 'COMPLETE');
  const slots = files.map((file) => {
    const index = reusable.findIndex(
      ({ attributes }) => attributes.sourceFileChecksum === file.checksum,
    );
    return { file, existing: index === -1 ? undefined : reusable.splice(index, 1)[0] };
  });
  const kept = new Set(slots.map(({ existing }) => existing?.id));
  return { slots, remove: current.filter(({ id }) => !kept.has(id)) };
}

async function uploadScreenshot(
  client: AscClient,
  setId: string,
  file: ScreenshotFile,
): Promise<string> {
  const reserved = await client.createResource(
    'appScreenshots',
    { fileName: file.fileName, fileSize: file.bytes.length },
    { appScreenshotSet: { type: 'appScreenshotSets', id: setId } },
    ReservedScreenshot,
  );
  for (const operation of reserved.attributes.uploadOperations) {
    await client.upload(operation, file.bytes);
  }
  await client.update('appScreenshots', reserved.id, {
    uploaded: true,
    sourceFileChecksum: file.checksum,
  });
  return reserved.id;
}

async function pollScreenshots(
  client: AscClient,
  setId: string,
  wait: Wait,
  isWaitingFor: (screenshot: ScreenshotResource) => boolean,
): Promise<ScreenshotResource[]> {
  for (let round = 1; ; round += 1) {
    const screenshots = await readScreenshots(client, setId);
    if (!screenshots.some(isWaitingFor) || round === POLL_ROUNDS) {
      return screenshots;
    }
    await wait(POLL_INTERVAL_MS);
  }
}

async function waitForUploads(
  client: AscClient,
  setId: string,
  uploaded: ReadonlySet<string>,
  wait: Wait,
): Promise<{ screenshots: ScreenshotResource[]; pending: string[] }> {
  const isSettling = (screenshot: ScreenshotResource) =>
    uploaded.has(screenshot.id) &&
    (stateOf(screenshot) === 'AWAITING_UPLOAD' || isProcessing(screenshot));
  const screenshots = await pollScreenshots(client, setId, wait, isSettling);
  const failed = screenshots.filter(
    (screenshot) => uploaded.has(screenshot.id) && stateOf(screenshot) === 'FAILED',
  );
  if (failed.length > 0) {
    throw new Error(
      [
        'Apple が、次の写真を受け付けませんでした。写真を直してから、同じ呼び出しをやり直してください。',
        ...failed.map(describeFailure),
      ].join('\n'),
    );
  }
  return { screenshots, pending: screenshots.filter(isSettling).map(nameOf) };
}

function stateOf({ attributes }: ScreenshotResource): string | undefined {
  return attributes.assetDeliveryState?.state;
}

// Apple は、処理が終わって（COMPLETE）から少したつまで、sourceFileChecksum を返さない
function isProcessing(screenshot: ScreenshotResource): boolean {
  return (
    stateOf(screenshot) === 'UPLOAD_COMPLETE' ||
    (stateOf(screenshot) === 'COMPLETE' && screenshot.attributes.sourceFileChecksum === null)
  );
}

function describeFailure(screenshot: ScreenshotResource): string {
  const reasons = (screenshot.attributes.assetDeliveryState?.errors ?? []).map(
    ({ code, description }) => [code, description].filter(Boolean).join(': '),
  );
  return `- ${nameOf(screenshot)}: ${reasons.length === 0 ? '理由は返ってきませんでした' : reasons.join('、')}`;
}

function nameOf({ id, attributes }: ScreenshotResource): string {
  return attributes.fileName ?? id;
}

function sameOrder(before: ScreenshotResource[], order: string[]): boolean {
  return before.length === order.length && before.every(({ id }, index) => id === order[index]);
}

function summarize({ attributes }: ScreenshotResource): ScreenshotSummary {
  return {
    fileName: attributes.fileName,
    size:
      attributes.imageAsset === null
        ? null
        : `${attributes.imageAsset.width}x${attributes.imageAsset.height}`,
    state: attributes.assetDeliveryState?.state ?? null,
  };
}
