import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import {
  ensureVersion,
  RELEASE_TYPES,
  type EnsureVersionRequest,
} from '../plugin/src/ensure-version.ts';
import { DISTRIBUTED_VERSION_STATES, EDITABLE_VERSION_STATES } from '../plugin/src/versions.ts';
import {
  created,
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
const DRAFT_CREATED = '2026-11-08T10:00:00-08:00';
const NOW = Date.parse('2026-11-08T12:00:00Z');

type VersionFields = {
  releaseType?: string;
  earliestReleaseDate?: string;
  phasedRelease?: string;
  build?: string;
};

function version(
  id: string,
  versionString: string,
  appVersionState: string,
  createdDate: string,
  { releaseType = 'AFTER_APPROVAL', earliestReleaseDate, phasedRelease, build }: VersionFields = {},
) {
  return resource(
    'appStoreVersions',
    id,
    {
      versionString,
      appVersionState,
      releaseType,
      earliestReleaseDate: earliestReleaseDate ?? null,
      createdDate,
    },
    {
      build: build === undefined ? null : `builds:${build}`,
      appStoreVersionPhasedRelease:
        phasedRelease === undefined ? null : `appStoreVersionPhasedReleases:${phasedRelease}`,
    },
  );
}

function draft(fields: VersionFields = {}) {
  return version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION', DRAFT_CREATED, fields);
}

const live = version('v101', '1.0.1', 'READY_FOR_DISTRIBUTION', '2026-11-01T10:00:00-07:00');

function phased(id: string) {
  return resource('appStoreVersionPhasedReleases', id, {
    phasedReleaseState: 'INACTIVE',
    startDate: null,
    currentDayNumber: null,
  });
}

function app() {
  return page([
    resource('apps', APP_ID, { name: 'RepLog - Gym Workout Log', bundleId: BUNDLE_ID }),
  ]);
}

function ensure(fetchFn: typeof fetch, request: Partial<EnsureVersionRequest> = {}) {
  return ensureVersion(
    createClient(() => 'TOKEN', fetchFn),
    {
      bundleId: BUNDLE_ID,
      platform: 'IOS',
      versionString: '1.0.2',
      ...request,
    },
    () => NOW,
  );
}

function routesOf(fetchFn: ReturnType<typeof fakeFetch>): string[] {
  return sentWrites(fetchFn).map(({ method, path }) => `${method} ${path}`);
}

describe('ensureVersion', () => {
  it('その番号の版も、編集できる版も無ければ、版を作る', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([live]), page([draft({ releaseType: 'MANUAL' }), live])],
      'POST /v1/appStoreVersions': created('appStoreVersions', 'v102'),
    });

    const result = await ensure(fetchFn, { releaseType: 'MANUAL' });

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/appStoreVersions',
        body: {
          data: {
            type: 'appStoreVersions',
            attributes: { platform: 'IOS', versionString: '1.0.2', releaseType: 'MANUAL' },
            relationships: { app: { data: { type: 'apps', id: APP_ID } } },
          },
        },
      },
    ]);
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({
      versionString: '1.0.2',
      state: 'PREPARE_FOR_SUBMISSION',
      releaseType: 'MANUAL',
    });
  });

  it('編集できる版の番号が違えば、その版の番号を変える', async () => {
    const old = version('v10', '1.0', 'PREPARE_FOR_SUBMISSION', DRAFT_CREATED);
    const renamed = version('v10', '1.0.2', 'PREPARE_FOR_SUBMISSION', DRAFT_CREATED);
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([old, live]), page([renamed, live])],
      'PATCH /v1/appStoreVersions/v10': jsonResponse(200, { data: renamed }),
    });

    const result = await ensure(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'PATCH',
        path: '/v1/appStoreVersions/v10',
        body: {
          data: { type: 'appStoreVersions', id: 'v10', attributes: { versionString: '1.0.2' } },
        },
      },
    ]);
    expect([result.before?.versionString, result.after.versionString]).toEqual(['1.0', '1.0.2']);
  });

  it('頼んだとおりになっていれば、何も送らず、読み直さない', async () => {
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([draft(), live]) });

    const result = await ensure(fetchFn, { releaseType: 'AFTER_APPROVAL', phasedRelease: false });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(requestedUrls(fetchFn).filter(({ pathname }) => pathname === VERSIONS)).toHaveLength(1);
    expect(result.after).toEqual(result.before);
  });

  it('日時指定の公開をやめるときは、公開の日時も消す', async () => {
    const scheduled = draft({
      releaseType: 'SCHEDULED',
      earliestReleaseDate: '2026-12-01T01:00:00Z',
    });
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([scheduled, live]), page([draft({ releaseType: 'MANUAL' }), live])],
      'PATCH /v1/appStoreVersions/v102': jsonResponse(200, { data: draft() }),
    });

    await ensure(fetchFn, { releaseType: 'MANUAL' });

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'PATCH',
        path: '/v1/appStoreVersions/v102',
        body: {
          data: {
            type: 'appStoreVersions',
            id: 'v102',
            attributes: { releaseType: 'MANUAL', earliestReleaseDate: null },
          },
        },
      },
    ]);
  });

  it('同じ日時なら、時差の書き方が違っても変えない', async () => {
    const scheduled = draft({
      releaseType: 'SCHEDULED',
      earliestReleaseDate: '2026-12-01T01:00:00Z',
    });
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([scheduled, live]) });

    await ensure(fetchFn, {
      releaseType: 'SCHEDULED',
      earliestReleaseDate: '2026-12-01T10:00:00+09:00',
    });

    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('段階的リリースを、頼まれたとおりに付ける・外す', async () => {
    const withPhased = draft({ phasedRelease: 'p102' });
    const adding = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([draft(), live]), page([withPhased, live], { included: [phased('p102')] })],
      'POST /v1/appStoreVersionPhasedReleases': created('appStoreVersionPhasedReleases', 'p102'),
    });
    const removing = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([withPhased, live], { included: [phased('p102')] }), page([draft(), live])],
      'DELETE /v1/appStoreVersionPhasedReleases/p102': noContent(),
    });

    const added = await ensure(adding, { phasedRelease: true });
    const removed = await ensure(removing, { phasedRelease: false });

    expect(sentWrites(adding)).toEqual([
      {
        method: 'POST',
        path: '/v1/appStoreVersionPhasedReleases',
        body: {
          data: {
            type: 'appStoreVersionPhasedReleases',
            attributes: { phasedReleaseState: 'INACTIVE' },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v102' } } },
          },
        },
      },
    ]);
    expect(added.after.phasedRelease).toEqual({
      state: 'INACTIVE',
      startDate: null,
      currentDayNumber: null,
    });
    expect(sentWrites(removing)).toEqual([
      { method: 'DELETE', path: '/v1/appStoreVersionPhasedReleases/p102', body: undefined },
    ]);
    expect(removed.after.phasedRelease).toBeNull();
  });

  it('初めて出す版では、段階的リリースを飛ばし、飛ばしたことを返す', async () => {
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([draft()]) });

    const result = await ensure(fetchFn, { phasedRelease: true });

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.skipped).toEqual([
      { field: 'phasedRelease', reason: expect.stringContaining('初めて出す版') },
    ]);
  });

  it('審査中の版は変えず、変えられない理由を返す。頼んだとおりなら、そのまま返す', async () => {
    const waiting = version('v102', '1.0.2', 'WAITING_FOR_REVIEW', DRAFT_CREATED);
    const fetchFn = fakeFetch({
      '/v1/apps': [app(), app()],
      [VERSIONS]: [page([waiting, live]), page([waiting, live])],
    });

    await expect(ensure(fetchFn, { releaseType: 'MANUAL' })).rejects.toThrow(
      /1\.0\.2 は、いま WAITING_FOR_REVIEW なので変えられません/,
    );
    const same = await ensure(fetchFn, { releaseType: 'AFTER_APPROVAL' });

    expect(same.after).toEqual(same.before);
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('公開の日時は SCHEDULED のときだけ受け付け、違えば何も呼ばずに止める', async () => {
    const fetchFn = fakeFetch({});

    await expect(ensure(fetchFn, { releaseType: 'SCHEDULED' })).rejects.toThrow(
      /earliestReleaseDate/,
    );
    await expect(
      ensure(fetchFn, { releaseType: 'MANUAL', earliestReleaseDate: '2026-12-01T10:00:00+09:00' }),
    ).rejects.toThrow(/SCHEDULED にするときだけ/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Apple のエラーは、どの項目かを添えて返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live]),
      'POST /v1/appStoreVersions': jsonResponse(409, {
        errors: [
          {
            status: '409',
            code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
            title: 'An attribute value is invalid.',
            detail: 'The version number must be higher than the previous version.',
            source: { pointer: '/data/attributes/versionString' },
          },
        ],
      }),
    });

    await expect(ensure(fetchFn, { versionString: '1.0.0' })).rejects.toThrow(
      /409[\s\S]*ENTITY_ERROR\.ATTRIBUTE\.INVALID[\s\S]*（\/data\/attributes\/versionString）/,
    );
  });

  it('書く途中で接続が切れたら、届いたか分からないことと、やり直してよいことを返す', async () => {
    const reads = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([live]) });
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') {
        throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
      }
      return reads(input, init);
    });

    await expect(ensure(fetchFn)).rejects.toThrow(
      /socket hang up[\s\S]*届いたかは分かりません[\s\S]*やり直す/,
    );
  });

  it('書かない設定では、送るはずだったリクエストを返し、何も送らない', async () => {
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([live]) });

    const result = ensureVersion(
      createClient(() => 'TOKEN', fetchFn, true),
      {
        bundleId: BUNDLE_ID,
        platform: 'IOS',
        versionString: '1.0.2',
      },
    );

    await expect(result).rejects.toThrow(
      /送りませんでした: POST \/v1\/appStoreVersions .*"versionString":"1\.0\.2"/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('公開したことのある番号を頼むと、大きい番号を使うよう返し、編集中の版も変えない', async () => {
    const editing = version('v103', '1.0.3', 'PREPARE_FOR_SUBMISSION', DRAFT_CREATED);
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([editing, live]) });

    await expect(ensure(fetchFn, { versionString: '1.0.1' })).rejects.toThrow(
      '版 1.0.1 は、公開したことのある番号です（READY_FOR_DISTRIBUTION）。次に出す版は、1.0.1 より大きい番号にしてください。',
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('審査中の版があれば、新しい版は作らず、どの版が待っているかを返す', async () => {
    const waiting = version('v102', '1.0.2', 'WAITING_FOR_REVIEW', DRAFT_CREATED);
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([waiting, live]) });

    await expect(ensure(fetchFn, { versionString: '1.0.3' })).rejects.toThrow(
      /版 1\.0\.2 が、いま WAITING_FOR_REVIEW なので、新しい版はまだ作れません/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('審査中の版には、段階的リリースも付けない', async () => {
    const waiting = version('v102', '1.0.2', 'WAITING_FOR_REVIEW', DRAFT_CREATED);
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([waiting, live]) });

    await expect(ensure(fetchFn, { phasedRelease: true })).rejects.toThrow(/審査から外すと/);
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('番号を変えた版にビルドが選んであれば、選び直すよう知らせる', async () => {
    const old = version('v10', '1.0', 'METADATA_REJECTED', DRAFT_CREATED, { build: 'b5' });
    const renamed = version('v10', '1.0.2', 'METADATA_REJECTED', DRAFT_CREATED, { build: 'b5' });
    const built = () => ({
      included: [resource('builds', 'b5', { version: '5', uploadedDate: DRAFT_CREATED })],
    });
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([old, live], built()), page([renamed, live], built())],
      'PATCH /v1/appStoreVersions/v10': jsonResponse(200, { data: renamed }),
    });

    const result = await ensure(fetchFn);

    expect(result.warnings).toEqual([
      expect.stringMatching(/選んであるビルド 5 は、前の番号のときのビルドです[\s\S]*select_build/),
    ]);
  });

  it('作った版は読み直してから、その版の id で、段階的リリースを付ける', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([live]),
        page([draft(), live]),
        page([draft({ phasedRelease: 'p102' }), live], { included: [phased('p102')] }),
      ],
      'POST /v1/appStoreVersions': created('appStoreVersions', 'v102'),
      'POST /v1/appStoreVersionPhasedReleases': created('appStoreVersionPhasedReleases', 'p102'),
    });

    const result = await ensure(fetchFn, { phasedRelease: true });

    expect(routesOf(fetchFn)).toEqual([
      'POST /v1/appStoreVersions',
      'POST /v1/appStoreVersionPhasedReleases',
    ]);
    expect(sentWrites(fetchFn)[1]?.body).toMatchObject({
      data: { relationships: { appStoreVersion: { data: { id: 'v102' } } } },
    });
    expect(result.warnings).toEqual([]);
  });

  it('作った版に段階的リリースが写っていれば、頼まれたとおりに外す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([live]),
        page([draft({ phasedRelease: 'p102' }), live], { included: [phased('p102')] }),
        page([draft(), live]),
      ],
      'POST /v1/appStoreVersions': created('appStoreVersions', 'v102'),
      'DELETE /v1/appStoreVersionPhasedReleases/p102': noContent(),
    });

    await ensure(fetchFn, { phasedRelease: false });

    expect(routesOf(fetchFn)).toEqual([
      'POST /v1/appStoreVersions',
      'DELETE /v1/appStoreVersionPhasedReleases/p102',
    ]);
  });

  it('途中で失敗したら、済んだ書き込みを添えて返し、やり直すと残りだけを送る', async () => {
    const failing = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([live]), page([draft(), live])],
      'POST /v1/appStoreVersions': created('appStoreVersions', 'v102'),
      'POST /v1/appStoreVersionPhasedReleases': jsonResponse(500, {
        errors: [{ status: '500', code: 'UNEXPECTED_ERROR' }],
      }),
    });
    const retrying = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([draft(), live]),
        page([draft({ phasedRelease: 'p102' }), live], { included: [phased('p102')] }),
      ],
      'POST /v1/appStoreVersionPhasedReleases': created('appStoreVersionPhasedReleases', 'p102'),
    });

    await expect(ensure(failing, { phasedRelease: true })).rejects.toThrow(
      /^版 1\.0\.2 を作りました。段階的リリースを付けるところで止まりました。同じ呼び出しをやり直すと、残りだけを行います。\n[\s\S]*500/,
    );
    await ensure(retrying, { phasedRelease: true });

    expect(routesOf(retrying)).toEqual(['POST /v1/appStoreVersionPhasedReleases']);
  });

  it('頼んだ値と違う値が入っていたら、知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [page([draft(), live]), page([draft(), live])],
      'PATCH /v1/appStoreVersions/v102': jsonResponse(200, { data: draft() }),
    });

    const result = await ensure(fetchFn, { releaseType: 'MANUAL' });

    expect(result.warnings).toEqual([
      'App Store Connect の値が、頼んだものと違います: 公開のしかたが AFTER_APPROVAL です（頼んだのは MANUAL）',
    ]);
  });

  it('置き換わった版しか無いアプリも、公開したことのあるアプリとして、段階的リリースを付ける', async () => {
    const replaced = version(
      'v100',
      '1.0.0',
      'REPLACED_WITH_NEW_VERSION',
      '2026-10-01T10:00:00-07:00',
    );
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: [
        page([draft(), replaced]),
        page([draft({ phasedRelease: 'p102' }), replaced], { included: [phased('p102')] }),
      ],
      'POST /v1/appStoreVersionPhasedReleases': created('appStoreVersionPhasedReleases', 'p102'),
    });

    const result = await ensure(fetchFn, { phasedRelease: true });

    expect(result.skipped).toEqual([]);
    expect(routesOf(fetchFn)).toEqual(['POST /v1/appStoreVersionPhasedReleases']);
  });

  it('公開する日時は、正時で、いまより先のものだけ受け付ける', async () => {
    const fetchFn = fakeFetch({});

    await expect(
      ensure(fetchFn, {
        releaseType: 'SCHEDULED',
        earliestReleaseDate: '2026-12-01T10:30:00+09:00',
      }),
    ).rejects.toThrow(/正時/);
    await expect(
      ensure(fetchFn, {
        releaseType: 'SCHEDULED',
        earliestReleaseDate: '2026-11-01T10:00:00+09:00',
      }),
    ).rejects.toThrow(/もう過ぎています/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('状態と公開のしかたの名前が、Apple の仕様にある', () => {
    expect(specAt('/components/schemas/AppVersionState/enum')).toEqual(
      expect.arrayContaining([...EDITABLE_VERSION_STATES, ...DISTRIBUTED_VERSION_STATES]),
    );
    expect(
      specAt(
        '/components/schemas/AppStoreVersion/properties/attributes/properties/releaseType/enum',
      ),
    ).toEqual([...RELEASE_TYPES]);
  });
});
