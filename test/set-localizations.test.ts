import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { EDITABLE_APP_INFO_STATES, REPLACED_APP_INFO_STATE } from '../plugin/src/localizations.ts';
import { setLocalizations, type LocalizationInput } from '../plugin/src/set-localizations.ts';
import {
  created,
  fakeFetch,
  jsonResponse,
  page,
  requestedUrls,
  resource,
  sentWrites,
} from './fake-api.ts';
import { specAt } from './openapi.ts';

const APP_ID = '6829263258';
const BUNDLE_ID = 'com.ihideck.hikeshi';
const VERSIONS = `/v1/apps/${APP_ID}/appStoreVersions`;
const VERSION_TEXTS = '/v1/appStoreVersions/v101/appStoreVersionLocalizations';
const APP_INFOS = `/v1/apps/${APP_ID}/appInfos`;
const APP_INFO_TEXTS = '/v1/appInfos/i-edit/appInfoLocalizations';

function version(id: string, versionString: string, appVersionState: string, createdDate: string) {
  return resource(
    'appStoreVersions',
    id,
    {
      versionString,
      appVersionState,
      releaseType: 'MANUAL',
      earliestReleaseDate: null,
      copyright: '2026 iHideck',
      createdDate,
    },
    { build: null, appStoreVersionPhasedRelease: null },
  );
}

const live = version('v100', '1.0.0', 'READY_FOR_DISTRIBUTION', '2026-11-01T10:00:00-07:00');
const draft = version('v101', '1.0.1', 'PREPARE_FOR_SUBMISSION', '2026-11-08T10:00:00-08:00');

function versionText(id: string, locale: string, fields: Record<string, string | null> = {}) {
  return resource('appStoreVersionLocalizations', id, {
    locale,
    description: `${locale} の概要`,
    keywords: '消防設備,自主点検',
    promotionalText: null,
    whatsNew: null,
    supportUrl: 'https://hikeshi.web.app/support',
    marketingUrl: null,
    ...fields,
  });
}

function appInfoText(id: string, locale: string, fields: Record<string, string | null> = {}) {
  return resource('appInfoLocalizations', id, {
    locale,
    name: 'ひけし',
    subtitle: '消火器の点検と報告書',
    privacyPolicyUrl: 'https://hikeshi.web.app/privacy',
    ...fields,
  });
}

function appInfos() {
  return page([
    resource('appInfos', 'i-live', { state: 'READY_FOR_DISTRIBUTION' }),
    resource('appInfos', 'i-edit', { state: 'PREPARE_FOR_SUBMISSION' }),
    resource('appInfos', 'i-old', { state: REPLACED_APP_INFO_STATE }),
  ]);
}

function app() {
  return page([resource('apps', APP_ID, { name: 'ひけし', bundleId: BUNDLE_ID })]);
}

function set(fetchFn: typeof fetch, localizations: LocalizationInput[]) {
  return setLocalizations(
    createClient(() => 'TOKEN', fetchFn),
    {
      bundleId: BUNDLE_ID,
      platform: 'IOS',
      localizations,
    },
  );
}

function patch(type: string, id: string, attributes: Record<string, string | null>) {
  return {
    method: 'PATCH',
    path: `/v1/${type}/${id}`,
    body: { data: { type, id, attributes } },
  };
}

describe('setLocalizations', () => {
  it('変わる項目だけを、言語と置き場所ごとにまとめて送り、前と後を返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: [
        page([versionText('lja', 'ja'), versionText('len', 'en-US')]),
        page([
          versionText('lja', 'ja', { keywords: '消防設備,点検' }),
          versionText('len', 'en-US', { promotionalText: 'Check fire equipment.' }),
        ]),
      ],
      [APP_INFOS]: [appInfos(), appInfos()],
      [APP_INFO_TEXTS]: [
        page([appInfoText('aja', 'ja')]),
        page([appInfoText('aja', 'ja', { subtitle: '消火器と設備の点検' })]),
      ],
      'PATCH /v1/appStoreVersionLocalizations/lja': jsonResponse(200, { data: {} }),
      'PATCH /v1/appInfoLocalizations/aja': jsonResponse(200, { data: {} }),
      'PATCH /v1/appStoreVersionLocalizations/len': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, [
      {
        locale: 'ja',
        description: 'ja の概要',
        keywords: '消防設備,点検',
        subtitle: '消火器と設備の点検',
      },
      { locale: 'en-US', promotionalText: 'Check fire equipment.' },
    ]);

    expect(sentWrites(fetchFn)).toEqual([
      patch('appStoreVersionLocalizations', 'lja', { keywords: '消防設備,点検' }),
      patch('appInfoLocalizations', 'aja', { subtitle: '消火器と設備の点検' }),
      patch('appStoreVersionLocalizations', 'len', { promotionalText: 'Check fire equipment.' }),
    ]);
    expect(result.version).toEqual({ versionString: '1.0.1', state: 'PREPARE_FOR_SUBMISSION' });
    expect(result.changes).toEqual([
      { locale: 'ja', field: 'keywords', before: '消防設備,自主点検', after: '消防設備,点検' },
      {
        locale: 'ja',
        field: 'subtitle',
        before: '消火器の点検と報告書',
        after: '消火器と設備の点検',
      },
      { locale: 'en-US', field: 'promotionalText', before: null, after: 'Check fire equipment.' },
    ]);
  });

  it('頼んだとおりなら、何も送らず、読み直さない。App 情報の項目が無ければ、App 情報も読まない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: page([versionText('lja', 'ja')]),
    });

    const result = await set(fetchFn, [{ locale: 'ja', keywords: '消防設備,自主点検' }]);

    expect(sentWrites(fetchFn)).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(
      requestedUrls(fetchFn).filter(({ pathname }) => pathname === VERSION_TEXTS),
    ).toHaveLength(1);
  });

  it('上限を超えた文・URL でない URL・重なった言語を、全部挙げて、何も呼ばずに止める', async () => {
    const fetchFn = fakeFetch({});

    const result = set(fetchFn, [
      { locale: 'ja', name: 'あ'.repeat(31), promotionalText: 'い'.repeat(171) },
      {
        locale: 'en-US',
        supportUrl: 'hikeshi.web.app/support',
        marketingUrl: 'ftp://hikeshi.web.app',
      },
      { locale: 'ja', keywords: '点検' },
    ]);

    await expect(result).rejects.toThrow(
      [
        'The check before writing found problems. Nothing was changed.',
        '- Locale ja appears more than once. Merge the entries into one',
        '- Promotional Text for ja: 171 characters (limit: 170)',
        '- Name for ja: 31 characters (limit: 30)',
        '- Support URL for en-US: not an http or https URL',
        '- Marketing URL for en-US: not an http or https URL',
      ].join('\n'),
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('キーワードは、バイトでなく文字の数で数える', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: [
        page([versionText('lja', 'ja')]),
        page([versionText('lja', 'ja', { keywords: '点'.repeat(100) })]),
      ],
      'PATCH /v1/appStoreVersionLocalizations/lja': jsonResponse(200, { data: {} }),
    });

    await expect(
      set(fakeFetch({}), [{ locale: 'ja', keywords: '点'.repeat(101) }]),
    ).rejects.toThrow('101 characters (limit: 100)');
    await set(fetchFn, [{ locale: 'ja', keywords: '点'.repeat(100) }]);

    expect(sentWrites(fetchFn)).toEqual([
      patch('appStoreVersionLocalizations', 'lja', { keywords: '点'.repeat(100) }),
    ]);
  });

  it('まだ無い言語は、渡した項目で版と App 情報に作り、作ったことを返す', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: [
        page([versionText('lja', 'ja')]),
        page([
          versionText('lja', 'ja'),
          versionText('lfr', 'fr-FR', {
            description: 'Inspection',
            keywords: null,
            supportUrl: null,
          }),
        ]),
      ],
      [APP_INFOS]: appInfos(),
      [APP_INFO_TEXTS]: [
        page([appInfoText('aja', 'ja')]),
        page([
          appInfoText('aja', 'ja'),
          appInfoText('afr', 'fr-FR', { name: 'Hikeshi', subtitle: null, privacyPolicyUrl: null }),
        ]),
      ],
      'POST /v1/appStoreVersionLocalizations': created('appStoreVersionLocalizations', 'lfr'),
      'POST /v1/appInfoLocalizations': created('appInfoLocalizations', 'afr'),
    });

    const result = await set(fetchFn, [
      { locale: 'fr-FR', description: 'Inspection', keywords: '', name: 'Hikeshi' },
    ]);

    expect(sentWrites(fetchFn)).toEqual([
      {
        method: 'POST',
        path: '/v1/appStoreVersionLocalizations',
        body: {
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: { locale: 'fr-FR', description: 'Inspection' },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v101' } } },
          },
        },
      },
      {
        method: 'POST',
        path: '/v1/appInfoLocalizations',
        body: {
          data: {
            type: 'appInfoLocalizations',
            attributes: { locale: 'fr-FR', name: 'Hikeshi' },
            relationships: { appInfo: { data: { type: 'appInfos', id: 'i-edit' } } },
          },
        },
      },
    ]);
    expect(result.addedLocales).toEqual([
      { locale: 'fr-FR', to: 'version' },
      { locale: 'fr-FR', to: 'appInfo' },
    ]);
    expect(result.changes).toEqual([
      { locale: 'fr-FR', field: 'description', before: null, after: 'Inspection' },
      { locale: 'fr-FR', field: 'name', before: null, after: 'Hikeshi' },
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining('Added locale fr-FR to the version text'),
      expect.stringContaining('Added locale fr-FR to the App Information'),
    ]);
  });

  it('App 情報にまだ無い言語で name が無ければ、ほかの言語も含めて何も変えずに止める', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: page([versionText('lja', 'ja')]),
      [APP_INFOS]: appInfos(),
      [APP_INFO_TEXTS]: page([appInfoText('aja', 'ja')]),
    });

    await expect(
      set(fetchFn, [
        { locale: 'ja', keywords: '点検' },
        { locale: 'de-DE', subtitle: 'Brandschutz' },
      ]),
    ).rejects.toThrow(
      /Locale de-DE is not in the App Information yet\. Pass name to add it[\s\S]*Nothing was changed/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('App Store Connect が受け付けない言語コードは、近いコードを添えて、何も呼ばずに止める', async () => {
    const fetchFn = fakeFetch({});

    const result = set(fetchFn, [
      { locale: 'ja-JP', keywords: '点検' },
      { locale: 'fr', description: 'Inspection' },
      { locale: 'xx-YY', description: 'Inspection' },
    ]);

    await expect(result).rejects.toThrow(
      [
        'The check before writing found problems. Nothing was changed.',
        '- Locale ja-JP is not an App Store locale (did you mean ja?)',
        '- Locale fr is not an App Store locale (did you mean fr-FR or fr-CA?)',
        '- Locale xx-YY is not an App Store locale',
        'App Store Connect accepts these locales: ar-SA, bn-BD,',
      ].join('\n'),
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('初めて出す版では、新機能の文を飛ばし、ほかの項目は入れる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([draft]),
      [VERSION_TEXTS]: [
        page([versionText('lja', 'ja')]),
        page([versionText('lja', 'ja', { promotionalText: '新しくなりました' })]),
      ],
      'PATCH /v1/appStoreVersionLocalizations/lja': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, [
      { locale: 'ja', whatsNew: '不具合を直しました。', promotionalText: '新しくなりました' },
    ]);

    expect(sentWrites(fetchFn)).toEqual([
      patch('appStoreVersionLocalizations', 'lja', { promotionalText: '新しくなりました' }),
    ]);
    expect(result.skipped).toEqual([
      { locale: 'ja', field: 'whatsNew', reason: expect.stringContaining('first release') },
    ]);
  });

  it('App 情報に編集できるものが無ければ、名前などは変えずに止める', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: page([versionText('lja', 'ja')]),
      [APP_INFOS]: page([resource('appInfos', 'i-live', { state: 'READY_FOR_DISTRIBUTION' })]),
    });

    await expect(
      set(fetchFn, [{ locale: 'ja', keywords: '点検', name: 'ひけし 点検' }]),
    ).rejects.toThrow(
      /no App Information is editable now \(App Information states: READY_FOR_DISTRIBUTION\)/,
    );
    expect(sentWrites(fetchFn)).toEqual([]);
  });

  it('null と空の文は、消すとして送る。もう無ければ送らない', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: [
        page([versionText('lja', 'ja', { promotionalText: 'セール中', keywords: '点検' })]),
        page([versionText('lja', 'ja', { keywords: null })]),
      ],
      'PATCH /v1/appStoreVersionLocalizations/lja': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, [
      { locale: 'ja', keywords: null, promotionalText: '', marketingUrl: '' },
    ]);

    expect(sentWrites(fetchFn)).toEqual([
      patch('appStoreVersionLocalizations', 'lja', { keywords: null, promotionalText: null }),
    ]);
    expect(result.changes).toEqual([
      { locale: 'ja', field: 'keywords', before: '点検', after: null },
      { locale: 'ja', field: 'promotionalText', before: 'セール中', after: null },
    ]);
  });

  it('途中で失敗したら、済んだ言語を添えて返し、やり直すと残りだけを送る', async () => {
    const failing = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: page([versionText('lja', 'ja'), versionText('len', 'en-US')]),
      'PATCH /v1/appStoreVersionLocalizations/lja': jsonResponse(200, { data: {} }),
      'PATCH /v1/appStoreVersionLocalizations/len': jsonResponse(500, {
        errors: [{ status: '500', code: 'UNEXPECTED_ERROR' }],
      }),
    });
    const retrying = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: [
        page([versionText('lja', 'ja', { keywords: '点検' }), versionText('len', 'en-US')]),
        page([
          versionText('lja', 'ja', { keywords: '点検' }),
          versionText('len', 'en-US', { keywords: 'inspection' }),
        ]),
      ],
      'PATCH /v1/appStoreVersionLocalizations/len': jsonResponse(200, { data: {} }),
    });
    const texts = [
      { locale: 'ja', keywords: '点検' },
      { locale: 'en-US', keywords: 'inspection' },
    ];

    await expect(set(failing, texts)).rejects.toThrow(
      /^Updated the Keywords for ja\. Stopped while updating the Keywords for en-US\. Make the same call again to do only the rest\.\n[\s\S]*500/,
    );
    await set(retrying, texts);

    expect(sentWrites(retrying)).toEqual([
      patch('appStoreVersionLocalizations', 'len', { keywords: 'inspection' }),
    ]);
  });

  it('入った値が頼んだものと違えば、知らせる', async () => {
    const fetchFn = fakeFetch({
      '/v1/apps': app(),
      [VERSIONS]: page([live, draft]),
      [VERSION_TEXTS]: [
        page([versionText('lja', 'ja')]),
        page([versionText('lja', 'ja', { promotionalText: '新しくなりました' })]),
      ],
      'PATCH /v1/appStoreVersionLocalizations/lja': jsonResponse(200, { data: {} }),
    });

    const result = await set(fetchFn, [{ locale: 'ja', promotionalText: '新しくなりました。\n' }]);

    expect(result.warnings).toEqual([
      expect.stringContaining('differs from the requested value: Promotional Text for ja'),
    ]);
  });

  it('編集できる App 情報の状態の名前が、Apple の仕様にある', () => {
    expect(
      specAt('/components/schemas/AppInfo/properties/attributes/properties/state/enum'),
    ).toEqual(expect.arrayContaining([...EDITABLE_APP_INFO_STATES]));
  });
});
