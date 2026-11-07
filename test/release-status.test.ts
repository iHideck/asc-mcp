import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { getReleaseStatus } from '../plugin/src/release-status.ts';
import { REPLACED_VERSION_STATE } from '../plugin/src/versions.ts';
import { fakeFetch, page, requestedUrls, resource } from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6826307654';
const BUNDLE_ID = 'com.ihideck.machosterone';

function routes() {
  return {
    '/v1/apps': page([
      resource('apps', APP_ID, { name: 'RepLog - Gym Workout Log', bundleId: BUNDLE_ID }),
    ]),
    '/v1/builds': page(
      [
        resource(
          'builds',
          'b12',
          {
            version: '12',
            uploadedDate: '2026-11-07T10:00:00-08:00',
            expired: false,
            processingState: 'VALID',
          },
          {
            preReleaseVersion: 'preReleaseVersions:pv101',
            buildBetaDetail: 'buildBetaDetails:bd12',
            betaGroups: ['betaGroups:g1'],
            buildUpload: 'buildUploads:u12',
          },
        ),
        resource(
          'builds',
          'b11',
          {
            version: '11',
            uploadedDate: '2026-10-01T10:00:00-07:00',
            expired: true,
            processingState: 'VALID',
          },
          {
            preReleaseVersion: 'preReleaseVersions:pv100',
            buildBetaDetail: 'buildBetaDetails:bd11',
            betaGroups: [],
            buildUpload: null,
          },
        ),
      ],
      {
        included: [
          resource('preReleaseVersions', 'pv101', { version: '1.0.1' }),
          resource('preReleaseVersions', 'pv100', { version: '1.0.0' }),
          resource('buildBetaDetails', 'bd12', {
            internalBuildState: 'IN_BETA_TESTING',
            externalBuildState: 'READY_FOR_BETA_SUBMISSION',
          }),
          resource('buildBetaDetails', 'bd11', {
            internalBuildState: 'EXPIRED',
            externalBuildState: 'EXPIRED',
          }),
          resource('betaGroups', 'g1', { name: 'チーム', isInternalGroup: true }),
          resource('buildUploads', 'u12', {
            state: {
              errors: [],
              warnings: [{ code: 'ITMS-90725', description: 'SDK version issue.' }],
            },
          }),
        ],
        next: '/v1/builds?cursor=AQ',
      },
    ),
    // Apple が返す順は、作った日の順とは限らない
    [`/v1/apps/${APP_ID}/appStoreVersions`]: page(
      [
        resource(
          'appStoreVersions',
          'v100',
          {
            versionString: '1.0.0',
            appVersionState: 'READY_FOR_DISTRIBUTION',
            releaseType: 'MANUAL',
            earliestReleaseDate: null,
            createdDate: '2026-09-20T10:00:00-07:00',
          },
          {
            build: 'builds:b11',
            appStoreVersionPhasedRelease: 'appStoreVersionPhasedReleases:p100',
          },
        ),
        resource(
          'appStoreVersions',
          'v090',
          {
            versionString: '0.9.0',
            appVersionState: REPLACED_VERSION_STATE,
            releaseType: 'MANUAL',
            earliestReleaseDate: null,
            createdDate: '2026-08-01T10:00:00-07:00',
          },
          { build: null, appStoreVersionPhasedRelease: null },
        ),
        resource(
          'appStoreVersions',
          'v101',
          {
            versionString: '1.0.1',
            appVersionState: 'PREPARE_FOR_SUBMISSION',
            releaseType: 'AFTER_APPROVAL',
            earliestReleaseDate: null,
            createdDate: '2026-11-07T11:00:00-08:00',
          },
          { build: 'builds:b12', appStoreVersionPhasedRelease: null },
        ),
      ],
      {
        included: [
          resource('builds', 'b11', { version: '11', uploadedDate: '2026-10-01T10:00:00-07:00' }),
          resource('builds', 'b12', { version: '12', uploadedDate: '2026-11-07T10:00:00-08:00' }),
          resource('appStoreVersionPhasedReleases', 'p100', {
            phasedReleaseState: 'COMPLETE',
            startDate: '2026-09-25T00:00:00-07:00',
            currentDayNumber: 7,
          }),
        ],
      },
    ),
  };
}

describe('getReleaseStatus', () => {
  it('新しいビルドと、公開中の版・次に出す版を、新しい順に返す', async () => {
    const fetchFn = fakeFetch(routes());

    const status = await getReleaseStatus(
      createClient(() => 'TOKEN', fetchFn),
      BUNDLE_ID,
      'IOS',
    );

    expect(status).toEqual({
      app: { appleId: APP_ID, name: 'RepLog - Gym Workout Log', bundleId: BUNDLE_ID },
      platform: 'IOS',
      builds: [
        {
          version: '1.0.1',
          buildNumber: '12',
          uploadedDate: '2026-11-07T10:00:00-08:00',
          processingState: 'VALID',
          expired: false,
          testFlight: { internal: 'IN_BETA_TESTING', external: 'READY_FOR_BETA_SUBMISSION' },
          betaGroups: [{ name: 'チーム', internal: true }],
          uploadIssues: {
            errors: [],
            warnings: [{ code: 'ITMS-90725', description: 'SDK version issue.' }],
          },
        },
        {
          version: '1.0.0',
          buildNumber: '11',
          uploadedDate: '2026-10-01T10:00:00-07:00',
          processingState: 'VALID',
          expired: true,
          testFlight: { internal: 'EXPIRED', external: 'EXPIRED' },
          betaGroups: [],
          uploadIssues: null,
        },
      ],
      versions: [
        {
          versionString: '1.0.1',
          state: 'PREPARE_FOR_SUBMISSION',
          releaseType: 'AFTER_APPROVAL',
          earliestReleaseDate: null,
          createdDate: '2026-11-07T11:00:00-08:00',
          build: { buildNumber: '12', uploadedDate: '2026-11-07T10:00:00-08:00' },
          phasedRelease: null,
        },
        {
          versionString: '1.0.0',
          state: 'READY_FOR_DISTRIBUTION',
          releaseType: 'MANUAL',
          earliestReleaseDate: null,
          createdDate: '2026-09-20T10:00:00-07:00',
          build: { buildNumber: '11', uploadedDate: '2026-10-01T10:00:00-07:00' },
          phasedRelease: {
            state: 'COMPLETE',
            startDate: '2026-09-25T00:00:00-07:00',
            currentDayNumber: 7,
          },
        },
      ],
    });
  });

  it('ビルドは、アップロードの新しい順の1ページ目だけを読む', async () => {
    const fetchFn = fakeFetch(routes());

    await getReleaseStatus(
      createClient(() => 'TOKEN', fetchFn),
      BUNDLE_ID,
      'IOS',
    );

    const builds = requestedUrls(fetchFn).filter(({ pathname }) => pathname === '/v1/builds');
    expect(builds).toHaveLength(1);
    expect(Object.fromEntries(builds[0]?.searchParams ?? [])).toMatchObject({
      'filter[app]': APP_ID,
      'filter[preReleaseVersion.platform]': 'IOS',
      sort: '-uploadedDate',
      limit: '5',
      include: 'preReleaseVersion,buildBetaDetail,betaGroups,buildUpload',
    });
  });

  it('置き換わった版の状態の名前が、Apple の仕様にある', () => {
    expect(specAt('/components/schemas/AppVersionState/enum')).toContain(REPLACED_VERSION_STATE);
  });
});
