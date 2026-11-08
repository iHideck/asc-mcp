import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import {
  DISPLAY_TYPE_NAMES,
  POLL_ROUNDS,
  replaceScreenshots,
  type ReplaceScreenshotsRequest,
} from '../plugin/src/screenshots.ts';
import {
  created,
  fakeFetch,
  jsonResponse,
  noContent,
  page,
  resource,
  sentWrites,
} from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6754036371';
const BUNDLE_ID = 'com.ihideck.hikeshi';
const SETS = '/v1/appStoreVersionLocalizations/lja/appScreenshotSets';
const SCREENSHOTS = '/v1/appScreenshotSets/set1/appScreenshots';
const ORDER = 'PATCH /v1/appScreenshotSets/set1/relationships/appScreenshots';
const UPLOAD = 'https://store-001.blobstore.apple.com';

let dir: string;

// 名前ごとに、中身の違う写真を作る（MD5 が名前ごとに違う）
const pictures = {
  question: { name: '1_question.png', bytes: png(1206, 2622, 'question') },
  report: { name: '2_report.png', bytes: png(1206, 2622, 'report') },
  summary: { name: '3_summary.png', bytes: png(1206, 2622, 'summary') },
  detail: { name: '4_detail.jpg', bytes: jpeg(1206, 2622) },
  large: { name: 'large.png', bytes: png(1320, 2868, 'large') },
  ipad: { name: 'ipad.jpg', bytes: jpeg(2064, 2752) },
  progressive: { name: 'progressive.jpg', bytes: jpeg(1668, 2224, 0xc2) },
  text: { name: 'notes.txt', bytes: Buffer.from('画面写真ではない') },
  shortPng: { name: 'short.png', bytes: png(1206, 2622, 'short').subarray(0, 20) },
  shortJpeg: { name: 'short.jpg', bytes: jpeg(1206, 2622).subarray(0, 18) },
};
type Picture = keyof typeof pictures;

function png(width: number, height: number, seed: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`seed\0${seed}`)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 読む側は CRC を確かめないので、0 で埋める
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

// 大きさの区切り（SOF）の前に、大きさを持たない区切り（APP0 とハフマンの表）を置く
function jpeg(width: number, height: number, frame = 0xc0): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt16BE(height, 0);
  size.writeUInt16BE(width, 2);
  return Buffer.concat([
    Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x04, 0x00, 0x00,
    ]),
    Buffer.from([0xff, frame, 0x00, 0x0b, 0x08]),
    size,
    Buffer.from([0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]),
  ]);
}

function pathOf(picture: Picture): string {
  return join(dir, pictures[picture].name);
}

function md5(picture: Picture): string {
  return createHash('md5').update(pictures[picture].bytes).digest('hex');
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asc-mcp-screenshots-'));
  await Promise.all(
    Object.values(pictures).map(({ name, bytes }) => writeFile(join(dir, name), bytes)),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function version(state = 'PREPARE_FOR_SUBMISSION') {
  return resource(
    'appStoreVersions',
    'v110',
    {
      versionString: '1.1.0',
      appVersionState: state,
      releaseType: 'MANUAL',
      earliestReleaseDate: null,
      createdDate: '2026-11-08T10:00:00Z',
    },
    { build: null, appStoreVersionPhasedRelease: null },
  );
}

// Apple は、処理が済んでからでないと、MD5（sourceFileChecksum）を返さない
function screenshot(
  id: string,
  picture: Picture,
  state = 'COMPLETE',
  checksum: string | null = state === 'COMPLETE' ? md5(picture) : null,
) {
  return resource('appScreenshots', id, {
    fileName: pictures[picture].name,
    sourceFileChecksum: checksum,
    imageAsset:
      state === 'COMPLETE'
        ? { templateUrl: 'https://example.com/{w}x{h}bb.{f}', width: 1206, height: 2622 }
        : null,
    assetDeliveryState: { state, errors: [], warnings: [] },
  });
}

function failed(id: string, picture: Picture) {
  return resource('appScreenshots', id, {
    fileName: pictures[picture].name,
    sourceFileChecksum: md5(picture),
    imageAsset: null,
    assetDeliveryState: {
      state: 'FAILED',
      errors: [{ code: 'IMAGE_TOOL_FAILURE', description: '画像を処理できませんでした' }],
      warnings: [],
    },
  });
}

function oldScreenshots(count: number) {
  return Array.from({ length: count }, (_, index) =>
    screenshot(`old${index}`, 'question', 'COMPLETE', `checksum-of-old-${index}`),
  );
}

function oldDeleteRoutes(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `DELETE /v1/appScreenshots/old${index}`,
      noContent(),
    ]),
  );
}

function oldDeletes(count: number) {
  return Array.from({ length: count }, (_, index) => deleted(`old${index}`));
}

function deleted(id: string) {
  return { method: 'DELETE', path: `/v1/appScreenshots/${id}`, body: undefined };
}

function repeat(count: number, make: () => Response): Response[] {
  return Array.from({ length: count }, make);
}

// Apple は、写真の枠を作ると、ファイルを分けて送る先を返す
function reserved(id: string, picture: Picture) {
  const { name, bytes } = pictures[picture];
  const half = Math.floor(bytes.length / 2);
  const part = (number: number, offset: number, length: number) => ({
    method: 'PUT',
    url: `${UPLOAD}/${id}/part${number}`,
    offset,
    length,
    requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
  });
  return jsonResponse(201, {
    data: resource('appScreenshots', id, {
      fileName: name,
      fileSize: bytes.length,
      uploadOperations: [part(1, 0, half), part(2, half, bytes.length - half)],
    }),
  });
}

function uploadRoutes(id: string, picture: Picture) {
  return {
    [`PUT ${UPLOAD}/${id}/part1`]: new Response(null, { status: 200 }),
    [`PUT ${UPLOAD}/${id}/part2`]: new Response(null, { status: 200 }),
    [`PATCH /v1/appScreenshots/${id}`]: jsonResponse(200, {
      data: screenshot(id, picture, 'UPLOAD_COMPLETE'),
    }),
  };
}

function routes(extra: Record<string, Response | Response[]>) {
  return {
    '/v1/apps': page([resource('apps', APP_ID, { name: '消防点検', bundleId: BUNDLE_ID })]),
    [`/v1/apps/${APP_ID}/appStoreVersions`]: page([version()]),
    '/v1/appStoreVersions/v110/appStoreVersionLocalizations': page([
      resource('appStoreVersionLocalizations', 'lja', {
        locale: 'ja',
        description: '消防設備の自主点検',
        keywords: null,
        promotionalText: null,
        whatsNew: null,
        supportUrl: null,
        marketingUrl: null,
      }),
    ]),
    [SETS]: page([
      resource('appScreenshotSets', 'set1', { screenshotDisplayType: 'APP_IPHONE_61' }),
    ]),
    ...extra,
  };
}

function request(...files: Picture[]): ReplaceScreenshotsRequest {
  return {
    bundleId: BUNDLE_ID,
    locale: 'ja',
    displayType: 'APP_IPHONE_61',
    files: files.map(pathOf),
  };
}

function replace(
  fetchFn: typeof fetch,
  replaceRequest: ReplaceScreenshotsRequest,
  { readOnly = false, wait = waiting() } = {},
) {
  return replaceScreenshots(
    createClient(() => 'TOKEN', fetchFn, readOnly),
    replaceRequest,
    wait,
  );
}

function waiting() {
  return vi.fn<(ms: number) => Promise<void>>(async () => {});
}

function order(...ids: string[]) {
  return {
    method: 'PATCH',
    path: '/v1/appScreenshotSets/set1/relationships/appScreenshots',
    body: { data: ids.map((id) => ({ type: 'appScreenshots', id })) },
  };
}

function reservation(picture: Picture) {
  const { name, bytes } = pictures[picture];
  return {
    method: 'POST',
    path: '/v1/appScreenshots',
    body: {
      data: {
        type: 'appScreenshots',
        attributes: { fileName: name, fileSize: bytes.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: 'set1' } } },
      },
    },
  };
}

function uploadWrites(id: string, picture: Picture) {
  return [
    reservation(picture),
    { method: 'PUT', path: `/${id}/part1`, body: undefined },
    { method: 'PUT', path: `/${id}/part2`, body: undefined },
    {
      method: 'PATCH',
      path: `/v1/appScreenshots/${id}`,
      body: {
        data: {
          type: 'appScreenshots',
          id,
          attributes: { uploaded: true, sourceFileChecksum: md5(picture) },
        },
      },
    },
  ];
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('失敗するはずの呼び出しが、通りました');
}

describe('replaceScreenshots', () => {
  it('足りない写真を先に上げ、Apple が受け付けてから要らない写真を消して、渡した順に並べる', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question'), screenshot('s2', 'report')]),
          page([
            screenshot('s1', 'question'),
            screenshot('s2', 'report'),
            screenshot('new1', 'summary', 'UPLOAD_COMPLETE'),
          ]),
          page([
            screenshot('s1', 'question'),
            screenshot('s2', 'report'),
            screenshot('new1', 'summary'),
          ]),
          page([screenshot('s1', 'question'), screenshot('new1', 'summary')]),
          page([screenshot('new1', 'summary'), screenshot('s1', 'question')]),
        ],
        'DELETE /v1/appScreenshots/s2': noContent(),
        'POST /v1/appScreenshots': reserved('new1', 'summary'),
        ...uploadRoutes('new1', 'summary'),
        [ORDER]: noContent(),
      }),
    );
    const wait = waiting();

    const result = await replace(fetchFn, request('summary', 'question'), { wait });

    expect(sentWrites(fetchFn)).toEqual([
      ...uploadWrites('new1', 'summary'),
      deleted('s2'),
      order('new1', 's1'),
    ]);
    expect(result).toMatchObject({
      versionString: '1.1.0',
      uploaded: ['3_summary.png'],
      removed: ['2_report.png'],
      before: [
        { fileName: '1_question.png', size: '1206x2622', state: 'COMPLETE' },
        { fileName: '2_report.png', size: '1206x2622', state: 'COMPLETE' },
      ],
      after: [
        { fileName: '3_summary.png', state: 'COMPLETE' },
        { fileName: '1_question.png', state: 'COMPLETE' },
      ],
      warnings: [],
    });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('Apple が返した送り先には、API のトークンを付けず、ファイルの指定の範囲を送る', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [page([]), page([screenshot('new1', 'summary')])],
        'POST /v1/appScreenshots': reserved('new1', 'summary'),
        ...uploadRoutes('new1', 'summary'),
      }),
    );

    await replace(fetchFn, request('summary'));

    const uploads = fetchFn.mock.calls.filter(([input]) => String(input).startsWith(UPLOAD));
    const { bytes } = pictures.summary;
    const half = Math.floor(bytes.length / 2);
    expect(uploads.map(([, init]) => Buffer.from(init?.body as Uint8Array))).toEqual([
      bytes.subarray(0, half),
      bytes.subarray(half),
    ]);
    for (const [, init] of uploads) {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('Content-Type')).toBe('image/png');
    }
  });

  it('送り先への送信が失敗したら、上げ終えたと伝えず、やり直しの案内を返す', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: page([]),
        'POST /v1/appScreenshots': reserved('new1', 'summary'),
        [`PUT ${UPLOAD}/new1/part1`]: new Response(null, { status: 503 }),
      }),
    );

    const message = await failureOf(replace(fetchFn, request('summary')));

    expect(message).toContain('503');
    expect(message).toContain('やり直すと');
    expect(sentWrites(fetchFn)).toEqual([
      reservation('summary'),
      { method: 'PUT', path: '/new1/part1', body: undefined },
    ]);
  });

  it('名前が同じでも、中身が違う写真は上げ直す', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question', 'COMPLETE', 'checksum-of-the-old-picture')]),
          page([
            screenshot('s1', 'question', 'COMPLETE', 'checksum-of-the-old-picture'),
            screenshot('new1', 'question'),
          ]),
          page([screenshot('new1', 'question')]),
        ],
        'DELETE /v1/appScreenshots/s1': noContent(),
        'POST /v1/appScreenshots': reserved('new1', 'question'),
        ...uploadRoutes('new1', 'question'),
      }),
    );

    const result = await replace(fetchFn, request('question'));

    expect(sentWrites(fetchFn)).toEqual([...uploadWrites('new1', 'question'), deleted('s1')]);
    expect(result).toMatchObject({ uploaded: ['1_question.png'], removed: ['1_question.png'] });
  });

  it('同じ中身の写真を2枚渡すと、2枚とも入れる', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question')]),
          page([screenshot('s1', 'question'), screenshot('new1', 'question')]),
        ],
        'POST /v1/appScreenshots': reserved('new1', 'question'),
        ...uploadRoutes('new1', 'question'),
      }),
    );

    await replace(fetchFn, request('question', 'question'));

    expect(sentWrites(fetchFn)).toEqual(uploadWrites('new1', 'question'));
  });

  it('同じ言語のほかの欄（iPad など）は、変えない', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SETS]: page([
          resource('appScreenshotSets', 'ipad', { screenshotDisplayType: 'APP_IPAD_PRO_3GEN_129' }),
          resource('appScreenshotSets', 'set1', { screenshotDisplayType: 'APP_IPHONE_61' }),
        ]),
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question'), screenshot('s2', 'report')]),
          page([screenshot('s1', 'question'), screenshot('s2', 'report')]),
          page([screenshot('s2', 'report'), screenshot('s1', 'question')]),
        ],
        [ORDER]: noContent(),
      }),
    );

    await replace(fetchFn, request('report', 'question'));

    expect(sentWrites(fetchFn)).toEqual([order('s2', 's1')]);
  });

  it('渡した写真と並びが欄と同じなら、何も送らない', async () => {
    const fetchFn = fakeFetch(
      routes({ [SCREENSHOTS]: page([screenshot('s1', 'question'), screenshot('s2', 'report')]) }),
    );

    const result = await replace(fetchFn, request('question', 'report'));

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result).toMatchObject({ uploaded: [], removed: [], warnings: [] });
  });

  it('並びだけが違えば、並べ替えだけを送る', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question'), screenshot('s2', 'report')]),
          page([screenshot('s1', 'question'), screenshot('s2', 'report')]),
          page([screenshot('s2', 'report'), screenshot('s1', 'question')]),
        ],
        [ORDER]: noContent(),
      }),
    );

    const result = await replace(fetchFn, request('report', 'question'));

    expect(sentWrites(fetchFn)).toEqual([order('s2', 's1')]);
    expect(result.after.map(({ fileName }) => fileName)).toEqual([
      '2_report.png',
      '1_question.png',
    ]);
  });

  it('欄がまだ無ければ、作ってから上げる。JPEG も大きさを読む', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SETS]: page([]),
        'POST /v1/appScreenshotSets': created('appScreenshotSets', 'set1'),
        'POST /v1/appScreenshots': reserved('new1', 'detail'),
        ...uploadRoutes('new1', 'detail'),
        [SCREENSHOTS]: page([screenshot('new1', 'detail')]),
      }),
    );

    const result = await replace(fetchFn, request('detail'));

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/appScreenshotSets',
        body: {
          data: {
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: 'APP_IPHONE_61' },
            relationships: {
              appStoreVersionLocalization: {
                data: { type: 'appStoreVersionLocalizations', id: 'lja' },
              },
            },
          },
        },
      },
      ...uploadWrites('new1', 'detail'),
    ]);
    expect(result).toMatchObject({ before: [], uploaded: ['4_detail.jpg'] });
  });

  it('欄に空きが足りなければ、入る分だけ先に上げ、残りは消してから上げる', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page(oldScreenshots(9)),
          page([...oldScreenshots(9), screenshot('new1', 'summary')]),
          page([screenshot('new1', 'summary'), screenshot('new2', 'report')]),
        ],
        ...oldDeleteRoutes(9),
        'POST /v1/appScreenshots': [reserved('new1', 'summary'), reserved('new2', 'report')],
        ...uploadRoutes('new1', 'summary'),
        ...uploadRoutes('new2', 'report'),
      }),
    );

    await replace(fetchFn, request('summary', 'report'));

    expect(sentWrites(fetchFn)).toEqual([
      ...uploadWrites('new1', 'summary'),
      ...oldDeletes(9),
      ...uploadWrites('new2', 'report'),
    ]);
  });

  it('欄が埋まっていれば先に消す。処理が終わらなければ、並べ替えずに止めて知らせる', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page(oldScreenshots(10)),
          ...repeat(POLL_ROUNDS, () =>
            page([
              screenshot('new1', 'report', 'UPLOAD_COMPLETE'),
              screenshot('new2', 'summary', 'UPLOAD_COMPLETE'),
            ]),
          ),
        ],
        ...oldDeleteRoutes(10),
        'POST /v1/appScreenshots': [reserved('new1', 'summary'), reserved('new2', 'report')],
        ...uploadRoutes('new1', 'summary'),
        ...uploadRoutes('new2', 'report'),
      }),
    );

    const result = await replace(fetchFn, request('summary', 'report'));

    expect(sentWrites(fetchFn)).toEqual([
      ...oldDeletes(10),
      ...uploadWrites('new1', 'summary'),
      ...uploadWrites('new2', 'report'),
    ]);
    expect(result.removed).toHaveLength(10);
    expect(result.warnings).toEqual([
      expect.stringContaining('まだ写真（2_report.png、3_summary.png）を処理しているので'),
    ]);
  });

  it('上げかけの写真と、処理に失敗した前の写真は消す。前の写真の失敗では止めない', async () => {
    const stale = screenshot('stale', 'report', 'AWAITING_UPLOAD');
    const broken = failed('broken', 'report');
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question'), stale, broken]),
          page([screenshot('s1', 'question'), stale, broken, screenshot('new1', 'report')]),
          page([screenshot('s1', 'question'), screenshot('new1', 'report')]),
        ],
        'DELETE /v1/appScreenshots/stale': noContent(),
        'DELETE /v1/appScreenshots/broken': noContent(),
        'POST /v1/appScreenshots': reserved('new1', 'report'),
        ...uploadRoutes('new1', 'report'),
      }),
    );

    await replace(fetchFn, request('question', 'report'));

    expect(sentWrites(fetchFn)).toEqual([
      ...uploadWrites('new1', 'report'),
      deleted('stale'),
      deleted('broken'),
    ]);
  });

  it('前の呼び出しで上げた写真は、処理が済んで MD5 が付くのを待ってから比べる', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question', 'UPLOAD_COMPLETE')]),
          page([screenshot('s1', 'question', 'COMPLETE', null)]),
          page([screenshot('s1', 'question')]),
        ],
      }),
    );
    const wait = waiting();

    const result = await replace(fetchFn, request('question'), { wait });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result).toMatchObject({ uploaded: [], removed: [] });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls.every(([ms]) => ms === 5000)).toBe(true);
  });

  it('前の写真の処理が終わらなければ、何も変えずに止める', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: repeat(POLL_ROUNDS, () =>
          page([screenshot('s1', 'question', 'UPLOAD_COMPLETE')]),
        ),
      }),
    );

    const message = await failureOf(replace(fetchFn, request('summary')));

    expect(message).toContain('まだ写真（1_question.png）を処理しているので、何も変えていません');
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('処理が済んでも MD5 が付かないままの写真は、別の写真として入れ替える', async () => {
    const unknown = screenshot('s1', 'question', 'COMPLETE', null);
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          ...repeat(POLL_ROUNDS, () => page([unknown])),
          page([unknown, screenshot('new1', 'question')]),
          page([screenshot('new1', 'question')]),
        ],
        'DELETE /v1/appScreenshots/s1': noContent(),
        'POST /v1/appScreenshots': reserved('new1', 'question'),
        ...uploadRoutes('new1', 'question'),
      }),
    );

    await replace(fetchFn, request('question'));

    expect(sentWrites(fetchFn)).toEqual([...uploadWrites('new1', 'question'), deleted('s1')]);
  });

  it('上げたあと、Apple が受け取って処理し終えるのを待つ', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([]),
          page([screenshot('new1', 'summary', 'AWAITING_UPLOAD')]),
          page([screenshot('new1', 'summary', 'COMPLETE', null)]),
          page([screenshot('new1', 'summary')]),
        ],
        'POST /v1/appScreenshots': reserved('new1', 'summary'),
        ...uploadRoutes('new1', 'summary'),
      }),
    );
    const wait = waiting();

    const result = await replace(fetchFn, request('summary'), { wait });

    expect(wait).toHaveBeenCalledTimes(2);
    expect(result.after).toEqual([
      { fileName: '3_summary.png', size: '1206x2622', state: 'COMPLETE' },
    ]);
  });

  it('Apple が写真を受け付けなければ、古い写真を消さずに、理由と終えたことを返す', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question')]),
          page([screenshot('s1', 'question'), failed('new1', 'summary')]),
        ],
        'POST /v1/appScreenshots': reserved('new1', 'summary'),
        ...uploadRoutes('new1', 'summary'),
      }),
    );

    const message = await failureOf(replace(fetchFn, request('summary')));

    expect(message).toContain('写真 3_summary.png を上げました');
    expect(message).toContain('3_summary.png: IMAGE_TOOL_FAILURE: 画像を処理できませんでした');
    expect(sentWrites(fetchFn)).toEqual(uploadWrites('new1', 'summary'));
  });

  it('Apple の処理が終わらなければ、古い写真を消さずに止めて知らせる', async () => {
    const fetchFn = fakeFetch(
      routes({
        [SCREENSHOTS]: [
          page([screenshot('s1', 'question')]),
          ...repeat(POLL_ROUNDS, () =>
            page([screenshot('s1', 'question'), screenshot('new1', 'summary', 'UPLOAD_COMPLETE')]),
          ),
        ],
        'POST /v1/appScreenshots': reserved('new1', 'summary'),
        ...uploadRoutes('new1', 'summary'),
      }),
    );
    const wait = waiting();

    const result = await replace(fetchFn, request('summary'), { wait });

    expect(sentWrites(fetchFn)).toEqual(uploadWrites('new1', 'summary'));
    expect(result).toMatchObject({ uploaded: ['3_summary.png'], removed: [] });
    expect(result.warnings).toEqual([
      expect.stringContaining('まだ写真（3_summary.png）を処理しているので'),
    ]);
    expect(wait).toHaveBeenCalledTimes(POLL_ROUNDS - 1);
  });

  it('大きさが欄と合わない写真や、読めないファイルがあれば、何も送らずに止める', async () => {
    const fetchFn = fakeFetch({});
    const files = [
      ...request('question', 'large', 'ipad', 'progressive', 'text', 'shortPng', 'shortJpeg').files,
      join(dir, 'missing.png'),
      'shots/1_question.png',
    ];

    const message = await failureOf(replace(fetchFn, { ...request(), files }));

    expect(message).toContain('何も変えていません');
    expect(message).toContain('1179x2556・2556x1179・1206x2622・2622x1206');
    expect(message).toContain(
      `${pathOf('large')}: 1320x2868 は、この欄の大きさではありません（APP_IPHONE_67 の欄の大きさです）`,
    );
    expect(message).toContain(
      `${pathOf('ipad')}: 2064x2752 は、この欄の大きさではありません（APP_IPAD_PRO_3GEN_129 の欄の大きさです）`,
    );
    expect(message).toContain(
      `${pathOf('progressive')}: 1668x2224 は、この欄の大きさではありません（APP_IPAD_105 の欄の大きさです）`,
    );
    for (const unreadable of ['text', 'shortPng', 'shortJpeg'] as const) {
      expect(message).toContain(
        `${pathOf(unreadable)}: PNG か JPEG の写真として、大きさを読めません`,
      );
    }
    expect(message).toContain(`${join(dir, 'missing.png')}: ファイルがありません`);
    expect(message).toContain('shots/1_question.png: 絶対パスで渡してください');
    expect(message).not.toContain(`${pathOf('question')}:`);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('版に無い言語を渡されたら、ある言語を返す', async () => {
    const fetchFn = fakeFetch(routes({}));

    await expect(replace(fetchFn, { ...request('question'), locale: 'en-US' })).rejects.toThrow(
      '版 1.1.0 に、言語 en-US はありません。ある言語は ja です。',
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('審査に出ている版では、何も送らずに止める', async () => {
    const fetchFn = fakeFetch(
      routes({ [`/v1/apps/${APP_ID}/appStoreVersions`]: page([version('WAITING_FOR_REVIEW')]) }),
    );

    await expect(
      replace(fetchFn, { ...request('question'), versionString: '1.1.0' }),
    ).rejects.toThrow('版 1.1.0 は、いま WAITING_FOR_REVIEW なので変えられません');
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('書かない設定では、最初の書き込みの前で止まる', async () => {
    const fetchFn = fakeFetch(
      routes({ [SCREENSHOTS]: page([screenshot('s1', 'question'), screenshot('s2', 'report')]) }),
    );

    await expect(
      replace(fetchFn, request('summary', 'question'), { readOnly: true }),
    ).rejects.toThrow('送りませんでした: POST /v1/appScreenshots');
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('扱う欄の名前は、どれも仕様の ScreenshotDisplayType にある', () => {
    const known = specAt('/components/schemas/ScreenshotDisplayType/enum') as string[];
    expect(DISPLAY_TYPE_NAMES.filter((name) => !known.includes(name))).toEqual([]);
  });
});
