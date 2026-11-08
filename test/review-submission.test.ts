import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import {
  cancelReview,
  OPEN_SUBMISSION_STATES,
  submitForReview,
  SUBMITTED_VERSION_STATES,
} from '../plugin/src/review-submission.ts';
import { created, fakeFetch, jsonResponse, page, resource, sentWrites } from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6826307654';
const BUNDLE_ID = 'com.ihideck.machosterone';
const VERSIONS = `/v1/apps/${APP_ID}/appStoreVersions`;
const SUBMISSIONS = `/v1/apps/${APP_ID}/reviewSubmissions`;

function version(state: string, build: string | null = 'b12', versionString = '1.0.2') {
  return resource(
    'appStoreVersions',
    'v102',
    {
      versionString,
      appVersionState: state,
      releaseType: 'AFTER_APPROVAL',
      earliestReleaseDate: null,
      createdDate: '2026-11-08T10:00:00-08:00',
    },
    { build: build === null ? null : `builds:${build}`, appStoreVersionPhasedRelease: null },
  );
}

function versions(state: string, build: string | null = 'b12') {
  return page([version(state, build)], {
    included: [
      resource('builds', 'b12', { version: '12', uploadedDate: '2026-11-08T09:00:00-08:00' }),
    ],
  });
}

type BuildFields = {
  processingState?: string;
  usesNonExemptEncryption?: boolean | null;
  preReleaseVersion?: string;
};

function builds({
  processingState = 'VALID',
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
          expired: false,
          processingState,
          buildAudienceType: 'APP_STORE_ELIGIBLE',
          usesNonExemptEncryption,
        },
        { preReleaseVersion: 'preReleaseVersions:pv' },
      ),
    ],
    { included: [resource('preReleaseVersions', 'pv', { version: preReleaseVersion })] },
  );
}

function submissions(...list: [string, string][]) {
  return page(
    list.map(([id, state]) => resource('reviewSubmissions', id, { state, submittedDate: null })),
  );
}

function items(...versionIds: string[]) {
  return page(
    versionIds.map((id, index) =>
      resource(
        'reviewSubmissionItems',
        `i${index}`,
        { state: 'READY_FOR_REVIEW' },
        {
          appStoreVersion: `appStoreVersions:${id}`,
        },
      ),
    ),
    {
      included: versionIds.map((id) =>
        resource('appStoreVersions', id, { versionString: '1.0.2' }),
      ),
    },
  );
}

function submission(state: string) {
  return jsonResponse(200, {
    data: resource('reviewSubmissions', 's1', { state, submittedDate: '2026-11-08T12:00:00Z' }),
  });
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
      'PATCH /v1/reviewSubmissions/s1': jsonResponse(200, { data: {} }),
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

  it('作りかけの提出があれば、それを使い、新しく作らない', async () => {
    const empty = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('PREPARE_FOR_SUBMISSION'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      '/v1/reviewSubmissions/s1/items': items(),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
      'PATCH /v1/reviewSubmissions/s1': jsonResponse(200, { data: {} }),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });
    const filled = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions('PREPARE_FOR_SUBMISSION'), versions('WAITING_FOR_REVIEW')],
      [SUBMISSIONS]: submissions(['s1', 'READY_FOR_REVIEW']),
      '/v1/reviewSubmissions/s1/items': items('v102'),
      '/v1/builds': builds(),
      'PATCH /v1/reviewSubmissions/s1': jsonResponse(200, { data: {} }),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    await submitForReview(client(empty), request);
    await submitForReview(client(filled), request);

    expect(routesOf(empty)).toEqual([
      'POST /v1/reviewSubmissionItems',
      'PATCH /v1/reviewSubmissions/s1',
    ]);
    expect(routesOf(filled)).toEqual(['PATCH /v1/reviewSubmissions/s1']);
  });

  it('もう審査に出してある版は、何も送らずに返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('WAITING_FOR_REVIEW'),
      [SUBMISSIONS]: submissions(['s1', 'WAITING_FOR_REVIEW']),
      '/v1/reviewSubmissions/s1/items': items('v102'),
    });

    const result = await submitForReview(client(fetchFn), request);

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.after).toEqual({
      version: 'WAITING_FOR_REVIEW',
      submission: 'WAITING_FOR_REVIEW',
    });
  });

  it('出す前にビルドを確かめ、出せなければ、理由を返して何も送らない', async () => {
    const cases: [ReturnType<typeof page>, BuildFields, RegExp][] = [
      [versions('PREPARE_FOR_SUBMISSION', null), {}, /ビルドが選んでありません[\s\S]*select_build/],
      [
        versions('PREPARE_FOR_SUBMISSION'),
        { preReleaseVersion: '1.0.1' },
        /版は 1\.0\.1 で、版の番号 1\.0\.2 と違います/,
      ],
      [versions('PREPARE_FOR_SUBMISSION'), { processingState: 'PROCESSING' }, /PROCESSING/],
      [
        versions('PREPARE_FOR_SUBMISSION'),
        { usesNonExemptEncryption: null },
        /輸出コンプライアンス/,
      ],
    ];
    for (const [listed, build, message] of cases) {
      const fetchFn = fakeFetch({
        '/v1/apps': app(),
        [VERSIONS]: listed,
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

  it('途中で失敗したら、済んだことを添えて返し、やり直すと作った提出を使う', async () => {
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
      '/v1/reviewSubmissions/s1/items': items(),
      '/v1/builds': builds(),
      'POST /v1/reviewSubmissionItems': created('reviewSubmissionItems', 'i1'),
      'PATCH /v1/reviewSubmissions/s1': jsonResponse(200, { data: {} }),
      '/v1/reviewSubmissions/s1': submission('WAITING_FOR_REVIEW'),
    });

    await expect(submitForReview(client(failing), request)).rejects.toThrow(
      /^審査への提出を作りました。提出に版 1\.0\.2 を入れるところで止まりました。/,
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
      '/v1/reviewSubmissions/s1/items': items('v102'),
      'PATCH /v1/reviewSubmissions/s1': jsonResponse(200, { data: {} }),
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

  it('審査に出していない版は、何も送らずに返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('PREPARE_FOR_SUBMISSION'),
      [SUBMISSIONS]: submissions(),
    });

    const result = await cancelReview(client(fetchFn), { ...request, versionString: '1.0.2' });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.after).toEqual(result.before);
  });

  it('却下されて直しを待つ提出と、作りかけの提出は、取り下げない', async () => {
    for (const [versionState, submissionState] of [
      ['REJECTED', 'UNRESOLVED_ISSUES'],
      ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW'],
    ] as const) {
      const fetchFn = fakeFetch({
        '/v1/apps': app(),
        [VERSIONS]: versions(versionState),
        [SUBMISSIONS]: submissions(['s1', submissionState]),
        '/v1/reviewSubmissions/s1/items': items('v102'),
      });

      const result = await cancelReview(client(fetchFn), { ...request, versionString: '1.0.2' });

      expect(sentWrites(fetchFn)).toEqual([]);
      expect(result.after).toEqual({ version: versionState, submission: submissionState });
    }
  });

  it('状態の名前が、Apple の仕様にある', () => {
    expect(
      specAt('/components/schemas/ReviewSubmission/properties/attributes/properties/state/enum'),
    ).toEqual(expect.arrayContaining([...OPEN_SUBMISSION_STATES, 'CANCELING']));
    expect(specAt('/components/schemas/AppVersionState/enum')).toEqual(
      expect.arrayContaining([...SUBMITTED_VERSION_STATES]),
    );
  });
});
