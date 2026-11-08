import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { setReviewDetail, type SetReviewDetailRequest } from '../plugin/src/review-detail.ts';
import {
  created,
  fakeFetch,
  jsonResponse,
  page,
  requestedUrls,
  resource,
  sentWrites,
} from './fake-api.ts';

const APP_ID = '6826307654';
const BUNDLE_ID = 'com.ihideck.machosterone';
const VERSIONS = `/v1/apps/${APP_ID}/appStoreVersions`;
const DETAIL = '/v1/appStoreVersions/v102/appStoreReviewDetail';

function version(id: string, versionString: string, appVersionState: string) {
  return resource(
    'appStoreVersions',
    id,
    {
      versionString,
      appVersionState,
      releaseType: 'AFTER_APPROVAL',
      earliestReleaseDate: null,
      createdDate: '2026-11-08T10:00:00-08:00',
    },
    { build: null, appStoreVersionPhasedRelease: null },
  );
}

const live = version('v101', '1.0.1', 'READY_FOR_DISTRIBUTION');
const draft = version('v102', '1.0.2', 'PREPARE_FOR_SUBMISSION');

const contact = {
  contactFirstName: '花子',
  contactLastName: '山田',
  contactPhone: '+81 90 0000 0000',
  contactEmail: 'review@example.com',
};

function detail(fields: Record<string, string | boolean | null> = {}) {
  return jsonResponse(200, {
    data: resource('appStoreReviewDetails', 'r102', {
      ...contact,
      demoAccountName: null,
      demoAccountRequired: false,
      notes: null,
      ...fields,
    }),
  });
}

function noDetail() {
  return jsonResponse(200, { data: null });
}

function app() {
  return page([
    resource('apps', APP_ID, { name: 'RepLog - Gym Workout Log', bundleId: BUNDLE_ID }),
  ]);
}

function set(fetchFn: typeof fetch, request: Partial<SetReviewDetailRequest> = {}) {
  return setReviewDetail(
    createClient(() => 'TOKEN', fetchFn),
    {
      bundleId: BUNDLE_ID,
      platform: 'IOS',
      ...request,
    },
  );
}

describe('setReviewDetail', () => {
  it('審査メモとサインインの要否のうち、変わるものだけを送り、前と後を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: [detail({ notes: '前のメモ' }), detail({ notes: '設定の画面から始めてください' })],
      'PATCH /v1/appStoreReviewDetails/r102': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, {
      notes: '設定の画面から始めてください',
      demoAccountRequired: false,
    });

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'PATCH',
        path: '/v1/appStoreReviewDetails/r102',
        body: {
          data: {
            type: 'appStoreReviewDetails',
            id: 'r102',
            attributes: { notes: '設定の画面から始めてください' },
          },
        },
      },
    ]);
    expect(result).toMatchObject({
      versionString: '1.0.2',
      before: { notes: '前のメモ', missingContact: [] },
      after: { notes: '設定の画面から始めてください', missingContact: [] },
      warnings: [],
    });
  });

  it('審査の情報が無ければ、頼んだ項目で作り、連絡先が無いことを知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: [
        noDetail(),
        detail({
          contactFirstName: null,
          contactLastName: null,
          contactPhone: null,
          contactEmail: null,
          notes: 'メモ',
        }),
      ],
      'POST /v1/appStoreReviewDetails': created('appStoreReviewDetails', 'r102'),
    });

    const result = await set(fetchFn, { notes: 'メモ' });

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/appStoreReviewDetails',
        body: {
          data: {
            type: 'appStoreReviewDetails',
            attributes: { notes: 'メモ' },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v102' } } },
          },
        },
      },
    ]);
    expect(result.before).toBeNull();
    expect(result.warnings).toEqual([
      expect.stringContaining('審査の連絡先（名・姓・電話番号・メール）が入っていません'),
    ]);
  });

  it('頼んだとおりなら、何も送らず、読み直さない。情報が無いままなら、そう知らせる', async () => {
    const same = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: detail({ notes: 'メモ' }),
    });
    const empty = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: noDetail(),
    });

    const result = await set(same, { notes: 'メモ' });
    const nothing = await set(empty, { notes: '' });

    expect(sentWrites(same)).toEqual([]);
    expect(requestedUrls(same).filter(({ pathname }) => pathname === DETAIL)).toHaveLength(1);
    expect(result.after).toEqual(result.before);
    expect(sentWrites(empty)).toEqual([]);
    expect(nothing.warnings).toEqual([expect.stringContaining('審査の情報がまだありません')]);
  });

  it('空の審査メモは、消すとして送る', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: [detail({ notes: 'メモ' }), detail()],
      'PATCH /v1/appStoreReviewDetails/r102': jsonResponse(200, { data: {} }),
    });

    await set(fetchFn, { notes: '' });

    expect(sentWrites(fetchFn)[0]?.body).toMatchObject({ data: { attributes: { notes: null } } });
  });

  it('サインインが要るのに審査用のアカウントが無ければ、画面で入れるよう知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: [detail(), detail({ demoAccountRequired: true })],
      'PATCH /v1/appStoreReviewDetails/r102': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, { demoAccountRequired: true });

    expect(result.warnings).toEqual([
      expect.stringContaining('審査用のアカウントが入っていません'),
    ]);
  });

  it('連絡先の値とパスワードは、読まず、返さない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: detail({ demoAccountName: 'reviewer' }),
    });

    const result = await set(fetchFn);

    const fields = requestedUrls(fetchFn)
      .find(({ pathname }) => pathname === DETAIL)
      ?.searchParams.get('fields[appStoreReviewDetails]');
    expect(fields?.split(',')).not.toContain('demoAccountPassword');
    expect(JSON.stringify(result)).not.toContain(contact.contactEmail);
    expect(JSON.stringify(result)).not.toContain(contact.contactPhone);
  });

  it('書いたあと読み直せなければ、入れたことを添えて返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft, live]),
      [DETAIL]: [
        detail(),
        jsonResponse(500, { errors: [{ status: '500', code: 'UNEXPECTED_ERROR' }] }),
      ],
      'PATCH /v1/appStoreReviewDetails/r102': jsonResponse(200, { data: {} }),
    });

    await expect(set(fetchFn, { notes: 'メモ' })).rejects.toThrow(
      /^版 1\.0\.2 の審査メモを入れました。入れた審査の情報を読み直すところで止まりました。/,
    );
  });

  it('編集できない版には入れない', async () => {
    const fetchFn = fakeFetch({ '/v1/apps': app(), [VERSIONS]: page([live]) });

    await expect(set(fetchFn, { notes: 'メモ' })).rejects.toThrow(
      /編集できる版[\s\S]*ensure_version/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });
});
