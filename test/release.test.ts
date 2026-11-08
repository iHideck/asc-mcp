import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { PENDING_RELEASE_STATE, releaseVersion, setPhasedRelease } from '../plugin/src/release.ts';
import { created, fakeFetch, jsonResponse, page, resource, sentWrites } from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6826307654';
const BUNDLE_ID = 'com.ihideck.machosterone';
const VERSIONS = `/v1/apps/${APP_ID}/appStoreVersions`;

function versions(state: string, phased: string | null = null) {
  return page(
    [
      resource(
        'appStoreVersions',
        'v102',
        {
          versionString: '1.0.2',
          appVersionState: state,
          releaseType: 'MANUAL',
          earliestReleaseDate: null,
          createdDate: '2026-11-08T10:00:00-08:00',
        },
        {
          build: null,
          appStoreVersionPhasedRelease:
            phased === null ? null : 'appStoreVersionPhasedReleases:p102',
        },
      ),
    ],
    {
      included:
        phased === null
          ? []
          : [
              resource('appStoreVersionPhasedReleases', 'p102', {
                phasedReleaseState: phased,
                startDate: phased === 'INACTIVE' ? null : '2026-11-10T00:00:00Z',
                currentDayNumber: phased === 'INACTIVE' ? null : 2,
              }),
            ],
    },
  );
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

describe('releaseVersion', () => {
  it('公開を待っている版を公開し、公開する前と後の版を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [versions(PENDING_RELEASE_STATE), versions('READY_FOR_DISTRIBUTION')],
      'POST /v1/appStoreVersionReleaseRequests': created('appStoreVersionReleaseRequests', 'r1'),
    });

    const result = await releaseVersion(client(fetchFn), request);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/appStoreVersionReleaseRequests',
        body: {
          data: {
            type: 'appStoreVersionReleaseRequests',
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v102' } } },
          },
        },
      },
    ]);
    expect([result.before.state, result.after.state]).toEqual([
      PENDING_RELEASE_STATE,
      'READY_FOR_DISTRIBUTION',
    ]);
  });

  it('公開済みの版は、何も送らずに返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('READY_FOR_DISTRIBUTION'),
    });

    const result = await releaseVersion(client(fetchFn), { ...request, versionString: '1.0.2' });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.after).toEqual(result.before);
  });

  it('公開を待っていない版は、公開せずに理由を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': [app(), app()],
      [VERSIONS]: [versions('WAITING_FOR_REVIEW'), versions('WAITING_FOR_REVIEW')],
    });

    await expect(
      releaseVersion(client(fetchFn), { ...request, versionString: '1.0.2' }),
    ).rejects.toThrow(/いま WAITING_FOR_REVIEW なので公開できません/);
    await expect(releaseVersion(client(fetchFn), request)).rejects.toThrow(
      '公開を待っている版（審査が通り、手動の公開を待っている版）がありません。',
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });
});

describe('setPhasedRelease', () => {
  it('段階的リリースを、止める・再開する・全員に出す', async () => {
    const cases = [
      ['ACTIVE', 'pause', 'PAUSED'],
      ['PAUSED', 'resume', 'ACTIVE'],
      ['ACTIVE', 'complete', 'COMPLETE'],
    ] as const;
    for (const [current, action, target] of cases) {
      const fetchFn = fakeFetch({
        '/v1/apps': app(),
        [VERSIONS]: [
          versions('READY_FOR_DISTRIBUTION', current),
          versions('READY_FOR_DISTRIBUTION', target),
        ],
        'PATCH /v1/appStoreVersionPhasedReleases/p102': jsonResponse(200, { data: {} }),
      });

      const result = await setPhasedRelease(client(fetchFn), { ...request, action });

      expect(sentWrites(fetchFn)).toEqual([
        {
          method: 'PATCH',
          path: '/v1/appStoreVersionPhasedReleases/p102',
          body: {
            data: {
              type: 'appStoreVersionPhasedReleases',
              id: 'p102',
              attributes: { phasedReleaseState: target },
            },
          },
        },
      ]);
      expect([result.before.phasedRelease?.state, result.after.phasedRelease?.state]).toEqual([
        current,
        target,
      ]);
    }
  });

  it('もうその状態なら、何も送らない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: versions('READY_FOR_DISTRIBUTION', 'PAUSED'),
    });

    await setPhasedRelease(client(fetchFn), { ...request, action: 'pause' });

    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('まだ始まっていない・もう終わった・無い段階的リリースは変えない', async () => {
    const cases = [
      [versions(PENDING_RELEASE_STATE, 'INACTIVE'), 'pause', /まだ始まっていません/],
      [versions('READY_FOR_DISTRIBUTION', 'COMPLETE'), 'resume', /もう終わっています/],
      [versions('READY_FOR_DISTRIBUTION'), 'pause', /段階的リリースがありません/],
    ] as const;
    for (const [listed, action, message] of cases) {
      const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: listed });

      await expect(
        setPhasedRelease(client(fetchFn), { ...request, versionString: '1.0.2', action }),
      ).rejects.toThrow(message);
      expect(sentWrites(fetchFn)).toEqual([]);
    }
  });

  it('状態の名前が、Apple の仕様にある', () => {
    expect(specAt('/components/schemas/AppVersionState/enum')).toContain(PENDING_RELEASE_STATE);
    expect(specAt('/components/schemas/PhasedReleaseState/enum')).toEqual(
      expect.arrayContaining(['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETE']),
    );
  });
});
