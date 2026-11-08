import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { copyReviewContact } from '../plugin/src/review-detail.ts';
import { created, fakeFetch, jsonResponse, page, resource, sentWrites } from './fake-api.ts';

const APP_ID = '6831431413';
const BUNDLE_ID = 'com.ihideck.languessr';
const SOURCE_ID = '6826307654';
const SOURCE = 'com.ihideck.machosterone';
const VERSIONS = `/v1/apps/${APP_ID}/appStoreVersions`;
const SOURCE_VERSIONS = `/v1/apps/${SOURCE_ID}/appStoreVersions`;
const DETAIL = '/v1/appStoreVersions/v100/appStoreReviewDetail';

const contact = {
  contactFirstName: '花子',
  contactLastName: '山田',
  contactPhone: '+81 90 1234 5678',
  contactEmail: 'review@example.com',
};

function version(id: string, versionString: string, state: string, createdDate: string) {
  return resource(
    'appStoreVersions',
    id,
    {
      versionString,
      appVersionState: state,
      releaseType: 'MANUAL',
      earliestReleaseDate: null,
      createdDate,
    },
    { build: null, appStoreVersionPhasedRelease: null },
  );
}

function detail(id: string, fields: Record<string, string | null> = {}) {
  return jsonResponse(200, {
    data: resource('appStoreReviewDetails', id, {
      contactFirstName: null,
      contactLastName: null,
      contactPhone: null,
      contactEmail: null,
      demoAccountName: null,
      demoAccountRequired: false,
      notes: null,
      ...fields,
    }),
  });
}

function app(id: string, bundleId: string) {
  return page([resource('apps', id, { name: bundleId, bundleId })]);
}

function routes(target: Response | Response[]) {
  return {
    '/v1/apps': [app(APP_ID, BUNDLE_ID), app(SOURCE_ID, SOURCE)],
    [VERSIONS]: page([version('v100', '1.0.0', 'PREPARE_FOR_SUBMISSION', '2026-11-08T10:00:00Z')]),
    [SOURCE_VERSIONS]: page([
      version('s101', '1.0.1', 'READY_FOR_DISTRIBUTION', '2026-11-06T10:00:00Z'),
      version('s100', '1.0.0', 'REPLACED_WITH_NEW_VERSION', '2026-11-01T10:00:00Z'),
    ]),
    // 新しい版（1.0.1）には連絡先が無く、前の版（1.0.0）にそろっている
    '/v1/appStoreVersions/s101/appStoreReviewDetail': detail('rs101', { contactEmail: null }),
    '/v1/appStoreVersions/s100/appStoreReviewDetail': detail('rs100', contact),
    [DETAIL]: target,
  };
}

function copy(fetchFn: typeof fetch, readOnly = false) {
  return copyReviewContact(
    createClient(() => 'TOKEN', fetchFn, readOnly),
    {
      bundleId: BUNDLE_ID,
      platform: 'IOS',
      fromBundleId: SOURCE,
    },
  );
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('失敗するはずの呼び出しが、通りました');
}

function containsContact(text: string): boolean {
  return Object.values(contact).some((value) => text.includes(value));
}

describe('copyReviewContact', () => {
  it('ほかのアプリの、連絡先がそろった版から写し、中身は返さない', async () => {
    const fetchFn = fakeFetch({
      ...routes([detail('r100', { contactFirstName: '花子' }), detail('r100', contact)]),
      'PATCH /v1/appStoreReviewDetails/r100': jsonResponse(200, { data: {} }),
    });

    const result = await copy(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'PATCH',
        path: '/v1/appStoreReviewDetails/r100',
        body: {
          data: {
            type: 'appStoreReviewDetails',
            id: 'r100',
            attributes: {
              contactLastName: contact.contactLastName,
              contactPhone: contact.contactPhone,
              contactEmail: contact.contactEmail,
            },
          },
        },
      },
    ]);
    expect(result).toMatchObject({
      versionString: '1.0.0',
      from: { bundleId: SOURCE, versionString: '1.0.0' },
      copied: ['contactLastName', 'contactPhone', 'contactEmail'],
      before: { missingContact: ['contactLastName', 'contactPhone', 'contactEmail'] },
      after: { missingContact: [] },
    });
    expect(containsContact(JSON.stringify(result))).toBe(false);
  });

  it('審査の情報が無ければ、連絡先を入れて作る', async () => {
    const fetchFn = fakeFetch({
      ...routes([jsonResponse(200, { data: null }), detail('r100', contact)]),
      'POST /v1/appStoreReviewDetails': created('appStoreReviewDetails', 'r100'),
    });

    await copy(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/appStoreReviewDetails',
        body: {
          data: {
            type: 'appStoreReviewDetails',
            attributes: contact,
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v100' } } },
          },
        },
      },
    ]);
  });

  it('同じ連絡先なら、何も送らない', async () => {
    const fetchFn = fakeFetch(routes(detail('r100', contact)));

    const result = await copy(fetchFn);

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.copied).toEqual([]);
  });

  it('Apple のエラーの文や、書かない設定のエラーの文に入った連絡先は、伏せて返す', async () => {
    const rejecting = fakeFetch({
      ...routes(detail('r100')),
      'PATCH /v1/appStoreReviewDetails/r100': jsonResponse(409, {
        errors: [
          {
            status: '409',
            code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
            detail: `The phone number '${contact.contactPhone}' is not valid.`,
          },
        ],
      }),
    });

    const rejected = await failureOf(copy(rejecting));
    const readOnly = await failureOf(copy(fakeFetch(routes(detail('r100'))), true));

    expect(rejected).toContain('（伏せた）');
    expect(readOnly).toContain('送りませんでした');
    expect([containsContact(rejected), containsContact(readOnly)]).toEqual([false, false]);
  });

  it('写す元に、そろった連絡先が無ければ、何も変えずに止める', async () => {
    const fetchFn = fakeFetch({
      ...routes(detail('r100')),
      '/v1/appStoreVersions/s100/appStoreReviewDetail': jsonResponse(200, { data: null }),
    });

    await expect(copy(fetchFn)).rejects.toThrow('そろった審査の連絡先がありません');
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('写す元と写す先が同じアプリなら、何も呼ばずに止める', async () => {
    const fetchFn = fakeFetch({});

    await expect(
      copyReviewContact(
        createClient(() => 'TOKEN', fetchFn),
        {
          bundleId: BUNDLE_ID,
          platform: 'IOS',
          fromBundleId: BUNDLE_ID,
        },
      ),
    ).rejects.toThrow('同じアプリです');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
