import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import {
  cancelReview,
  OPEN_SUBMISSION_STATES,
  SENT_SUBMISSION_STATES,
  submitForReview,
} from '../plugin/src/review-submission.ts';
import { created, fakeFetch, jsonResponse, page, resource, sentWrites } from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6826307654';
const BUNDLE_ID = 'com.ihideck.machosterone';
const VERSIONS = `/v1/apps/${APP_ID}/appStoreVersions`;
const SUBMISSIONS = `/v1/apps/${APP_ID}/reviewSubmissions`;
const ITEMS = '/v1/reviewSubmissions/s1/items';

function versions(state: string, build: string | null = 'b12') {
  return page(
    [
      resource(
        'appStoreVersions',
        'v102',
        {
          versionString: '1.0.2',
          appVersionState: state,
          releaseType: 'AFTER_APPROVAL',
          earliestReleaseDate: null,
          createdDate: '2026-11-08T10:00:00-08:00',
        },
        { build: build === null ? null : `builds:${build}`, appStoreVersionPhasedRelease: null },
      ),
    ],
    {
      included: [
        resource('builds', 'b12', { version: '12', uploadedDate: '2026-11-08T09:00:00-08:00' }),
      ],
    },
  );
}

type BuildFields = {
  processingState?: string;
  expired?: boolean;
  buildAudienceType?: string;
  usesNonExemptEncryption?: boolean | null;
  preReleaseVersion?: string;
};

function builds({
  processingState = 'VALID',
  expired = false,
  buildAudienceType = 'APP_STORE_ELIGIBLE',
  usesNonExemptEncryption = false,
  preReleaseVersion = '1.0.2',
}: BuildFields = {}) {
  return page(
    [
      resource(
        'builds',
        'b12',
        {
          version: '12',
          uploadedDate: '2026-11-08T09:00:00-08:00',
          expired,
          processingState,
          buildAudienceType,
          usesNonExemptEncryption,
        },
        { preReleaseVersion: 'preReleaseVersions:pv' },
      ),
    ],
    { included: [resource('preReleaseVersions', 'pv', { version: preReleaseVersion })] },
  );
}

function submissions(...list: [string, string][]) {
  return page(list.map(([id, state]) => resource('reviewSubmissions', id, { state })));
}

// 中身は「状態:版の id」で書く。版の id が無いものは、App 内課金など、版でない中身
function items(...list: string[]) {
  const parsed = list.map((entry) => {
    const [state = '', versionId = ''] = entry.split(':');
    return { state, versionId };
  });
  return page(
    parsed.map(({ state, versionId }, index) =>
      resource(
        'reviewSubmissionItems',
        `i${index}`,
        { state },
        { appStoreVersion: versionId === '' ? null : `appStoreVersions:${versionId}` },
      ),
    ),
    {
      included: parsed
        .filter(({ versionId }) => versionId !== '')
        .map(({ versionId }) =>
          resource('appStoreVersions', versionId, { versionString: '1.0.2' }),
        ),
    },
  );
}

function submission(state: string) {
  return jsonResponse(200, { data: resource('reviewSubmissions', 's1', { state }) });
}

function ok() {
  return jsonResponse(200, { data: {} });
}

function app() {
  return page([
    resource('apps', APP_ID, { name: 'RepLog - Gym Workout Log', bundleId: BUNDLE_ID }),
  ]);
}

function client(fetchFn: typeof fetch) {
  return createClient(() => 'TOKEN', fetchFn);
}

const request = { bundleId: BUNDLE_ID, platform: 'IOS' as const };

function routesOf(fetchFn: ReturnType<typeof fakeFetch>): string[] {
  return sentWrites(fetchFn).map(({ method, path }) => `${method} ${path}`);
}

describe('submitForReview', () => {
  it('提出を作り、版を入れて、審査に出す。出す前と後の状態を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('PREPARE_FOR_SUBMISSION'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissions': created('reviewSubmissions', 's1'),
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    const result = await submitForReview(client(fetchFn), request);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/reviewSubmissions',
        body: {
          data: {
            type: 'reviewSubmissions',
            attributes: { platform: 'IOS' },
            relationships: { app: { data: { type: 'apps', id: APP_ID } } },
          },
        },
      },
      {
        method: 'POST',
        path: '/v1/reviewSubmissionItems',
        body: {
          data: {
            type: 'reviewSubmissionItems',
            relationships: {
              reviewSubmission: { data: { type: 'reviewSubmissions', id: 's1' } },
              appStoreVersion: { data: { type: 'appStoreVersions', id: 'v102' } },
            },
          },
        },
      },
      {
        method: 'PATCH',
        path: '/v1/reviewSubmissions/s1',
        body: { data: { type: 'reviewSubmissions', id: 's1', attributes: { submitted: true } } },
      },
    ]);
    expect(result).toMatchObject({
      versionString: '1.0.2',
      buildNumber: '12',
      before: { version: 'PREPARE_FOR_SUBMISSION', submission: null },
      after: { version: 'WAITING_FOR_REVIEW', submission: 'WAITING_FOR_REVIEW' },
    });
  });

  it('作りかけの提出が空なら版を入れて出し、版が入っていれば出すだけにする', async () => {
    const empty = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('PREPARE_FOR_SUBMISSION'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      [ITEMS]: items(),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });
    const added = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('READY_FOR_REVIEW'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      [ITEMS]: items('READY_FOR_REVIEW:v102'),
      '/v1/builds': builds(),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    await submitForReview(client(empty), request);
    await submitForReview(client(added), request);

    expect(routesOf(empty)).toEqual([
      'POST /v1/reviewSubmissionItems',
      'PATCH /v1/reviewSubmissions/s1',
    ]);
    expect(routesOf(added)).toEqual(['PATCH /v1/reviewSubmissions/s1']);
  });

  it('提出から外された中身は、入っていないものとして、版を入れ直す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('PREPARE_FOR_SUBMISSION'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      [ITEMS]: items('REMOVED:v102'),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    await submitForReview(client(fetchFn), request);

    expect(routesOf(fetchFn)).toEqual([
      'POST /v1/reviewSubmissionItems',
      'PATCH /v1/reviewSubmissions/s1',
    ]);
  });

  it('出すところで断られたら、済んだことと Apple の知らせを返し、やり直すと出すだけを送る', async () => {
    const failing = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('PREPARE_FOR_SUBMISSION'),
      [SUBMISSIONS]: submissions(),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissions': created('reviewSubmissions', 's1'),
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
      'PATCH /v1/reviewSubmissions/s1': jsonResponse(409, {
        errors: [
          {
            status: '409',
            code: 'STATE_ERROR.ENTITY_STATE_INVALID',
            meta: {
              associatedErrors: {
                '/v1/appStoreVersions/v102': [
                  {
                    code: 'ENTITY_ERROR.ATTRIBUTE.REQUIRED',
                    detail: 'You must provide a value for the attribute whatsNew.',
                  },
                ],
              },
            },
          },
        ],
      }),
    });
    const retrying = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('READY_FOR_REVIEW'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      [ITEMS]: items('READY_FOR_REVIEW:v102'),
      '/v1/builds': builds(),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    const message = await submitForReview(client(failing), request).catch((error: unknown) =>
      error instanceof Error ? error.message : '',
    );
    await submitForReview(client(retrying), request);

    expect(message).toMatch(
      /^審査への提出を作りました。提出に版 1\.0\.2 を入れました。版 1\.0\.2 を審査に出すところで止まりました。エラーの所を直してから、/,
    );
    expect(message).toContain('ENTITY_ERROR.ATTRIBUTE.REQUIRED');
    expect(routesOf(retrying)).toEqual(['PATCH /v1/reviewSubmissions/s1']);
  });

  it('もう出してある版は、版の状態が遅れていても、何も送らない', async () => {
    const lagging = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('READY_FOR_REVIEW'),
      [SUBMISSIONS]: submissions(['s1', 'WAITING_FOR_REVIEW']),
      [ITEMS]: items('READY_FOR_REVIEW:v102'),
    });
    const waiting = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('WAITING_FOR_REVIEW'),
      [SUBMISSIONS]: submissions(),
    });

    const result = await submitForReview(client(lagging), request);
    await submitForReview(client(waiting), request);

    expect(sentWrites(lagging)).toEqual([]);
    expect(sentWrites(waiting)).toEqual([]);
    expect(result.after).toEqual({ version: 'READY_FOR_REVIEW', submission: 'WAITING_FOR_REVIEW' });
  });

  it('却下されたあとは、却下された中身を直したことにしてから出し、やり直すと出すだけを送る', async () => {
    const rejected = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('REJECTED'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'UNRESOLVED_ISSUES']),
      [ITEMS]: items('REJECTED:v102'),
      '/v1/builds': builds(),
      'PATCH /v1/reviewSubmissionItems/i0': ok(),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });
    const retrying = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('REJECTED'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'UNRESOLVED_ISSUES']),
      [ITEMS]: items('READY_FOR_REVIEW:v102'),
      '/v1/builds': builds(),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    await submitForReview(client(rejected), request);
    await submitForReview(client(retrying), request);

    expect(sentWrites(rejected)).toEqual([
      {
        method: 'PATCH',
        path: '/v1/reviewSubmissionItems/i0',
        body: { data: { type: 'reviewSubmissionItems', id: 'i0', attributes: { resolved: true } } },
      },
      {
        method: 'PATCH',
        path: '/v1/reviewSubmissions/s1',
        body: { data: { type: 'reviewSubmissions', id: 's1', attributes: { submitted: true } } },
      },
    ]);
    expect(routesOf(retrying)).toEqual(['PATCH /v1/reviewSubmissions/s1']);
  });

  it('作りかけの提出に、版のほかのものが入っていれば、出さずに知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('READY_FOR_REVIEW'),
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      [ITEMS]: items('READY_FOR_REVIEW:v102', 'READY_FOR_REVIEW'),
      '/v1/builds': builds(),
    });

    await expect(submitForReview(client(fetchFn), request)).rejects.toThrow(
      /版 1\.0\.2 のほかに 1 件（App 内課金など）が入っていて[\s\S]*何も変えていません/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('取り下げの最中なら、終わってから呼ぶよう返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('WAITING_FOR_REVIEW'),
      [SUBMISSIONS]: submissions(['s1', 'CANCELING']),
      [ITEMS]: items('READY_FOR_REVIEW:v102'),
    });

    await expect(submitForReview(client(fetchFn), request)).rejects.toThrow('取り下げの最中です');
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('出す前にビルドを確かめ、出せなければ、理由を返して何も送らない', async () => {
    const cases: [boolean, BuildFields, RegExp][] = [
      [false, {}, /ビルドが選んでありません[\s\S]*select_build/],
      [true, { preReleaseVersion: '1.0.1' }, /版は 1\.0\.1 で、版の番号 1\.0\.2 と違います/],
      [true, { processingState: 'PROCESSING' }, /PROCESSING[\s\S]*待ってください/],
      [true, { expired: true }, /期限が切れています/],
      [true, { buildAudienceType: 'INTERNAL_ONLY' }, /内部テスト専用/],
      [true, { usesNonExemptEncryption: null }, /輸出コンプライアンス/],
    ];
    for (const [selected, build, message] of cases) {
      const fetchFn = fakeFetch({
        '/v1/apps': app(),
        [VERSIONS]: versions('PREPARE_FOR_SUBMISSION', selected ? 'b12' : null),
        [SUBMISSIONS]: submissions(),
        '/v1/builds': builds(build),
      });

      await expect(submitForReview(client(fetchFn), request)).rejects.toThrow(message);
      expect(sentWrites(fetchFn)).toEqual([]);
    }
  });

  it('公開したことのある版は出さない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('READY_FOR_DISTRIBUTION'),
      [SUBMISSIONS]: submissions(),
    });

    await expect(
      submitForReview(client(fetchFn), { ...request, versionString: '1.0.2' }),
    ).rejects.toThrow('公開したことのある版です');
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('中身を入れるところで失敗したら、済んだことを添えて返し、やり直すと作った提出を使う', async () => {
    const failing = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('PREPARE_FOR_SUBMISSION'),
      [SUBMISSIONS]: submissions(),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissions': created('reviewSubmissions', 's1'),
      'POST /v1/reviewSubmissionItems': jsonResponse(500, {
        errors: [{ status: '500', code: 'UNEXPECTED_ERROR' }],
      }),
    });
    const retrying = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('PREPARE_FOR_SUBMISSION'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      [ITEMS]: items(),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    await expect(submitForReview(client(failing), request)).rejects.toThrow(
      /^審査への提出を作りました。提出に版 1\.0\.2 を入れるところで止まりました。同じ呼び出しをやり直すと/,
    );
    await submitForReview(client(retrying), request);

    expect(routesOf(retrying)).toEqual([
      'POST /v1/reviewSubmissionItems',
      'PATCH /v1/reviewSubmissions/s1',
    ]);
  });
});

describe('cancelReview', () => {
  it('審査待ちの版の提出を取り下げ、取り下げる前と後の状態を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('WAITING_FOR_REVIEW'), versions('DEVELOPER_REJECTED')],
      [SUBMISSIONS]: submissions(['s1', 'WAITING_FOR_REVIEW']),
      [ITEMS]: items('READY_FOR_REVIEW:v102'),
      'PATCH /v1/reviewSubmissions/s1': ok(),
      '/v1/reviewSubmissions/s1': submission('CANCELING'),
    });

    const result = await cancelReview(client(fetchFn), request);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'PATCH',
        path: '/v1/reviewSubmissions/s1',
        body: { data: { type: 'reviewSubmissions', id: 's1', attributes: { canceled: true } } },
      },
    ]);
    expect(result).toMatchObject({
      before: { version: 'WAITING_FOR_REVIEW', submission: 'WAITING_FOR_REVIEW' },
      after: { version: 'DEVELOPER_REJECTED', submission: 'CANCELING' },
    });
  });

  it('取り下げの最中なら、版を省いても指しても、何も送らずに返す', async () => {
    for (const [versionState, versionString] of [
      ['DEVELOPER_REJECTED', undefined],
      ['WAITING_FOR_REVIEW', '1.0.2'],
    ] as const) {
      const fetchFn = fakeFetch({
        '/v1/apps': app(),
        [VERSIONS]: versions(versionState),
        [SUBMISSIONS]: submissions(['s1', 'CANCELING']),
        [ITEMS]: items('READY_FOR_REVIEW:v102'),
      });

      const result = await cancelReview(client(fetchFn), { ...request, versionString });

      expect(sentWrites(fetchFn)).toEqual([]);
      expect(result.after).toEqual({ version: versionState, submission: 'CANCELING' });
    }
  });

  it('審査に出していない版と、却下されて直しを待つ版は、何も送らずに返す', async () => {
    for (const [versionState, list] of [
      ['PREPARE_FOR_SUBMISSION', []],
      ['REJECTED', [['s1', 'UNRESOLVED_ISSUES']]],
    ] as const) {
      const fetchFn = fakeFetch({
        '/v1/apps': app(),
        [VERSIONS]: versions(versionState),
        [SUBMISSIONS]: submissions(...list.map(([id, state]): [string, string] => [id, state])),
        [ITEMS]: items('REJECTED:v102'),
      });

      const result = await cancelReview(client(fetchFn), { ...request, versionString: '1.0.2' });

      expect(sentWrites(fetchFn)).toEqual([]);
      expect(result.after).toEqual(result.before);
    }
  });

  it('まだ出していない提出に入った版は、出すか、提出から外すよう返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('READY_FOR_REVIEW'),
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      [ITEMS]: items('READY_FOR_REVIEW:v102'),
    });

    await expect(cancelReview(client(fetchFn), request)).rejects.toThrow(
      /まだ出していない審査への提出に入っています[\s\S]*submit_for_review/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('提出に版のほかのものが入っていれば、取り下げずに知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('WAITING_FOR_REVIEW'),
      [SUBMISSIONS]: submissions(['s1', 'WAITING_FOR_REVIEW']),
      [ITEMS]: items('READY_FOR_REVIEW:v102', 'READY_FOR_REVIEW'),
    });

    await expect(cancelReview(client(fetchFn), request)).rejects.toThrow(
      /ほかに 1 件（App 内課金など）[\s\S]*一緒に取り下げます/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('状態の名前が、Apple の仕様にある', () => {
    expect(
      specAt('/components/schemas/ReviewSubmission/properties/attributes/properties/state/enum'),
    ).toEqual(expect.arrayContaining([...OPEN_SUBMISSION_STATES, ...SENT_SUBMISSION_STATES]));
    expect(
      specAt(
        '/components/schemas/ReviewSubmissionItem/properties/attributes/properties/state/enum',
      ),
    ).toEqual(expect.arrayContaining(['READY_FOR_REVIEW', 'REJECTED', 'REMOVED']));
  });
});
