import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { selectBuild, type SelectBuildRequest } from '../plugin/src/select-build.ts';
import {
  fakeFetch,
  jsonResponse,
  noContent,
  page,
  requestedUrls,
  resource,
  sentWrites,
} from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6826307654';
const BUNDLE_ID = 'com.ihideck.machosterone';
const VERSIONS = `/v1/apps/${APP_ID}/appStoreVersions`;

function version(
  id: string,
  versionString: string,
  appVersionState: string,
  build: string | null,
  createdDate = '2026-11-08T10:00:00-08:00',
) {
  return resource(
    'appStoreVersions',
    id,
    {
      versionString,
      appVersionState,
      releaseType: 'AFTER_APPROVAL',
      earliestReleaseDate: null,
      createdDate,
    },
    { build: build === null ? null : `builds:${build}`, appStoreVersionPhasedRelease: null },
  );
}

const live = version('v101', '1.0.1', 'READY_FOR_DISTRIBUTION', 'b9', '2026-11-01T10:00:00-07:00');

// 版の一覧に入る、選んだビルド
function chosen(id: string, number: string) {
  return resource('builds', id, { version: number, uploadedDate: '2026-11-08T09:00:00-08:00' });
}

type BuildFields = {
  processingState?: string;
  expired?: boolean;
  buildAudienceType?: string | null;
  usesNonExemptEncryption?: boolean | null;
  preReleaseVersion?: string;
};

function build(
  id: string,
  number: string,
  {
    processingState = 'VALID',
    expired = false,
    buildAudienceType = 'APP_STORE_ELIGIBLE',
    usesNonExemptEncryption = false,
    preReleaseVersion = 'pv102',
  }: BuildFields = {},
) {
  return resource(
    'builds',
    id,
    {
      version: number,
      uploadedDate: '2026-11-08T09:00:00-08:00',
      expired,
      processingState,
      buildAudienceType,
      usesNonExemptEncryption,
    },
    { preReleaseVersion: `preReleaseVersions:${preReleaseVersion}` },
  );
}

const preReleaseVersions = [
  resource('preReleaseVersions', 'pv102', { version: '1.0.2' }),
  resource('preReleaseVersions', 'pv1020', { version: '1.0.20' }),
];

function app() {
  return page([
    resource('apps', APP_ID, { name: 'RepLog - Gym Workout Log', bundleId: BUNDLE_ID }),
  ]);
}

function select(fetchFn: typeof fetch, request: Partial<SelectBuildRequest> = {}) {
  return selectBuild(
    createClient(() => 'TOKEN', fetchFn),
    {
      bundleId: BUNDLE_ID,
      platform: 'IOS',
      buildNumber: '12',
      ...request,
    },
  );
}

describe('selectBuild', () => {
  it('処理の済んだビルドを、編集できる版に選び、選ぶ前と後を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', 'b12'), live], {
          included: [chosen('b12', '12')],
        }),
      ],
      '/v1/builds': page([build('b12', '12'), build('b11', '11')], {
        included: preReleaseVersions,
      }),
      'PATCH /v1/appStoreVersions/v102/relationships/build': noContent(),
    });

    const result = await select(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'PATCH',
        path: '/v1/appStoreVersions/v102/relationships/build',
        body: { data: { type: 'builds', id: 'b12' } },
      },
    ]);
    expect(result).toMatchObject({
      versionString: '1.0.2',
      before: null,
      after: { buildNumber: '12' },
      warnings: [],
    });
    const builds = requestedUrls(fetchFn).find(({ pathname }) => pathname === '/v1/builds');
    expect(builds?.searchParams.get('filter[preReleaseVersion.version]')).toBe('1.0.2');
  });

  it('選んであるビルドと同じなら、何も送らない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', 'b12'), live], {
        included: [chosen('b12', '12')],
      }),
      '/v1/builds': page([build('b12', '12')], { included: preReleaseVersions }),
    });

    const result = await select(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.after).toEqual(result.before);
  });

  it('版の番号と同じ版のビルドが無ければ、ビルドの版を確かめるよう返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
      '/v1/builds': page([build('b30', '12', { preReleaseVersion: 'pv1020' })], {
        included: preReleaseVersions,
      }),
    });

    await expect(select(fetchFn)).rejects.toThrow(
      /1\.0\.2 のビルドがありません[\s\S]*CFBundleShortVersionString[\s\S]*get_release_status/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('その番号のビルドが無ければ、版にあるビルドの番号を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
      '/v1/builds': page([build('b12', '12'), build('b11', '11')], {
        included: preReleaseVersions,
      }),
    });

    await expect(select(fetchFn, { buildNumber: '13' })).rejects.toThrow(
      'この版のビルドは 12・11 です',
    );
  });

  it('処理中・期限切れ・内部テスト専用のビルドは、理由を返して選ばない', async () => {
    const builds = [
      build('b13', '13', { processingState: 'PROCESSING' }),
      build('b12', '12', { expired: true }),
      build('b11', '11', { buildAudienceType: 'INTERNAL_ONLY' }),
    ];
    const fetchFn = fakeFetch({
      '/v1/apps': [app(), app(), app()],
      [VERSIONS]: [1, 2, 3].map(() =>
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
      ),
      '/v1/builds': [1, 2, 3].map(() => page(builds, { included: preReleaseVersions })),
    });

    await expect(select(fetchFn, { buildNumber: '13' })).rejects.toThrow(/PROCESSING/);
    await expect(select(fetchFn, { buildNumber: '12' })).rejects.toThrow(/期限が切れています/);
    await expect(select(fetchFn, { buildNumber: '11' })).rejects.toThrow(/内部テスト専用/);
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('輸出コンプライアンスの答えが無いビルドは、選んだうえで知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', 'b12'), live], {
          included: [chosen('b12', '12')],
        }),
      ],
      '/v1/builds': page([build('b12', '12', { usesNonExemptEncryption: null })], {
        included: preReleaseVersions,
      }),
      'PATCH /v1/appStoreVersions/v102/relationships/build': noContent(),
    });

    const result = await select(fetchFn);

    expect(sentWrites(fetchFn)).toHaveLength(1);
    expect(result.warnings).toEqual([expect.stringContaining('輸出コンプライアンス')]);
  });

  it('編集できる版が無ければ、版を用意するよう返し、審査中の版には選ばない', async () => {
    const waiting = version('v102', '1.0.2', 'WAITING_FOR_REVIEW', 'b11');
    const fetchFn = fakeFetch({
      '/v1/apps': [app(), app()],
      [VERSIONS]: [page([live]), page([waiting, live])],
    });

    await expect(select(fetchFn)).rejects.toThrow(/編集できる版[\s\S]*ensure_version/);
    await expect(select(fetchFn, { versionString: '1.0.2' })).rejects.toThrow(
      /1\.0\.2 は、いま WAITING_FOR_REVIEW なので変えられません/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('選んだあとのビルドが、頼んだものと違えば知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
      ],
      '/v1/builds': page([build('b12', '12')], { included: preReleaseVersions }),
      'PATCH /v1/appStoreVersions/v102/relationships/build': noContent(),
    });

    const result = await select(fetchFn);

    expect(result.warnings).toEqual([
      'App Store Connect の値が、頼んだものと違います: 選んであるビルドが 無し です（頼んだのは 12）',
    ]);
  });

  it('選んだあと読み直せなければ、選んだことを添えて返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', null), live]),
        jsonResponse(500, { errors: [{ status: '500', code: 'UNEXPECTED_ERROR' }] }),
      ],
      '/v1/builds': page([build('b12', '12')], { included: preReleaseVersions }),
      'PATCH /v1/appStoreVersions/v102/relationships/build': noContent(),
    });

    await expect(select(fetchFn)).rejects.toThrow(
      /^版 1\.0\.2 にビルド 12 を選びました。選んだ版を読み直すところで止まりました。/,
    );
  });

  it('ビルドの状態の名前が、Apple の仕様にある', () => {
    expect(
      specAt('/components/schemas/Build/properties/attributes/properties/processingState/enum'),
    ).toContain('VALID');
    expect(specAt('/components/schemas/BuildAudienceType/enum')).toContain('INTERNAL_ONLY');
  });
});
