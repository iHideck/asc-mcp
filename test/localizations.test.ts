import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { getLocalizations, REPLACED_APP_INFO_STATE } from '../plugin/src/localizations.ts';
import { fakeFetch, page, requestedUrls, resource } from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6829263258';
const BUNDLE_ID = 'com.ihideck.hikeshi';

function version(id: string, versionString: string, appVersionState: string, createdDate: string) {
  return resource(
    'appStoreVersions',
    id,
    {
      versionString,
      appVersionState,
      releaseType: 'MANUAL',
      earliestReleaseDate: null,
      createdDate,
    },
    { build: null, appStoreVersionPhasedRelease: null },
  );
}

function versionLocalization(id: string, locale: string, whatsNew: string | null) {
  return resource('appStoreVersionLocalizations', id, {
    locale,
    description: `${locale} の概要`,
    keywords: '消防設備,自主点検',
    promotionalText: null,
    whatsNew,
    supportUrl: 'https://hikeshi.web.app/support',
    marketingUrl: null,
  });
}

function appInfoLocalization(id: string, locale: string, subtitle: string) {
  return resource('appInfoLocalizations', id, {
    locale,
    name: 'ひけし',
    subtitle,
    privacyPolicyUrl: 'https://hikeshi.web.app/privacy',
  });
}

function routes() {
  return {
    '/v1/apps': page([resource('apps', APP_ID, { name: 'ひけし', bundleId: BUNDLE_ID })]),
    [`/v1/apps/${APP_ID}/appStoreVersions`]: page([
      version('v100', '1.0.0', 'READY_FOR_DISTRIBUTION', '2026-11-01T10:00:00-07:00'),
      version('v101', '1.0.1', 'PREPARE_FOR_SUBMISSION', '2026-11-07T10:00:00-08:00'),
    ]),
    '/v1/appStoreVersions/v101/appStoreVersionLocalizations': page([
      versionLocalization('l101ja', 'ja', '不具合を直しました。'),
    ]),
    '/v1/appStoreVersions/v100/appStoreVersionLocalizations': page([
      versionLocalization('l100ja', 'ja', null),
    ]),
    [`/v1/apps/${APP_ID}/appInfos`]: page(
      [
        resource(
          'appInfos',
          'i-live',
          { state: 'READY_FOR_DISTRIBUTION' },
          {
            appInfoLocalizations: [
              'appInfoLocalizations:a-live-ja',
              'appInfoLocalizations:a-live-en',
            ],
          },
        ),
        resource(
          'appInfos',
          'i-edit',
          { state: 'PREPARE_FOR_SUBMISSION' },
          { appInfoLocalizations: ['appInfoLocalizations:a-edit-ja'] },
        ),
        resource(
          'appInfos',
          'i-old',
          { state: REPLACED_APP_INFO_STATE },
          { appInfoLocalizations: ['appInfoLocalizations:a-old-ja'] },
        ),
      ],
      {
        included: [
          appInfoLocalization('a-live-ja', 'ja', '消火器などの点検と報告書づくり'),
          appInfoLocalization('a-live-en', 'en-US', 'Fire safety self-inspection'),
          appInfoLocalization('a-edit-ja', 'ja', '消火器の点検と報告書'),
          appInfoLocalization('a-old-ja', 'ja', '昔のサブタイトル'),
        ],
      },
    ),
  };
}

describe('getLocalizations', () => {
  it('版を省くと、いちばん新しい版の文と、置き換わっていない App 情報の文を返す', async () => {
    const fetchFn = fakeFetch(routes());

    const localizations = await getLocalizations(
      createClient(() => 'TOKEN', fetchFn),
      {
        bundleId: BUNDLE_ID,
        platform: 'IOS',
      },
    );

    expect(localizations).toEqual({
      app: { appleId: APP_ID, name: 'ひけし', bundleId: BUNDLE_ID },
      version: { versionString: '1.0.1', state: 'PREPARE_FOR_SUBMISSION' },
      versionLocalizations: [
        {
          locale: 'ja',
          description: 'ja の概要',
          keywords: '消防設備,自主点検',
          promotionalText: null,
          whatsNew: '不具合を直しました。',
          supportUrl: 'https://hikeshi.web.app/support',
          marketingUrl: null,
        },
      ],
      appInfos: [
        {
          state: 'READY_FOR_DISTRIBUTION',
          localizations: [
            {
              locale: 'ja',
              name: 'ひけし',
              subtitle: '消火器などの点検と報告書づくり',
              privacyPolicyUrl: 'https://hikeshi.web.app/privacy',
            },
            {
              locale: 'en-US',
              name: 'ひけし',
              subtitle: 'Fire safety self-inspection',
              privacyPolicyUrl: 'https://hikeshi.web.app/privacy',
            },
          ],
        },
        {
          state: 'PREPARE_FOR_SUBMISSION',
          localizations: [
            {
              locale: 'ja',
              name: 'ひけし',
              subtitle: '消火器の点検と報告書',
              privacyPolicyUrl: 'https://hikeshi.web.app/privacy',
            },
          ],
        },
      ],
    });
  });

  it('版と言語を指すと、その版の、その言語の文だけを返す', async () => {
    const fetchFn = fakeFetch(routes());

    const localizations = await getLocalizations(
      createClient(() => 'TOKEN', fetchFn),
      {
        bundleId: BUNDLE_ID,
        platform: 'IOS',
        versionString: '1.0.0',
        locales: ['ja'],
      },
    );

    expect(localizations.version).toEqual({
      versionString: '1.0.0',
      state: 'READY_FOR_DISTRIBUTION',
    });
    expect(localizations.versionLocalizations.map(({ whatsNew }) => whatsNew)).toEqual([null]);
    expect(
      localizations.appInfos.map(({ localizations }) => localizations.map(({ locale }) => locale)),
    ).toEqual([['ja'], ['ja']]);
    const versionRequest = requestedUrls(fetchFn).find(({ pathname }) =>
      pathname.endsWith('/appStoreVersionLocalizations'),
    );
    expect(versionRequest?.pathname).toBe('/v1/appStoreVersions/v100/appStoreVersionLocalizations');
    expect(versionRequest?.searchParams.get('filter[locale]')).toBe('ja');
  });

  it('無い版を指すと、いまある版を添えて返す', async () => {
    const fetchFn = fakeFetch(routes());

    await expect(
      getLocalizations(
        createClient(() => 'TOKEN', fetchFn),
        {
          bundleId: BUNDLE_ID,
          platform: 'IOS',
          versionString: '2.0.0',
        },
      ),
    ).rejects.toThrow(
      '版 2.0.0 はありません。いまある版は 1.0.1（PREPARE_FOR_SUBMISSION）、1.0.0（READY_FOR_DISTRIBUTION）です。',
    );
  });

  it('置き換わった App 情報の状態の名前が、Apple の仕様にある', () => {
    expect(
      specAt('/components/schemas/AppInfo/properties/attributes/properties/state/enum'),
    ).toContain(REPLACED_APP_INFO_STATE);
  });
});
