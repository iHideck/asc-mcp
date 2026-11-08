import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { sparseFields, type AscClient } from './client.ts';
import { isCurrent, listVersions, type Platform, type Version } from './versions.ts';

export const REPLACED_APP_INFO_STATE = 'REPLACED_WITH_NEW_INFO';

export const EDITABLE_APP_INFO_STATES: readonly string[] = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
];

const VersionLocalization = z.object({
  type: z.literal('appStoreVersionLocalizations'),
  id: z.string(),
  attributes: z.object({
    locale: z.string(),
    description: z.string().nullable(),
    keywords: z.string().nullable(),
    promotionalText: z.string().nullable(),
    whatsNew: z.string().nullable(),
    supportUrl: z.string().nullable(),
    marketingUrl: z.string().nullable(),
  }),
});

const AppInfo = z.object({
  type: z.literal('appInfos'),
  id: z.string(),
  attributes: z.object({ state: z.string() }),
});

const AppInfoLocalization = z.object({
  type: z.literal('appInfoLocalizations'),
  id: z.string(),
  attributes: z.object({
    locale: z.string(),
    name: z.string().nullable(),
    subtitle: z.string().nullable(),
    privacyPolicyUrl: z.string().nullable(),
  }),
});

export type LocalizationsRequest = {
  bundleId: string;
  platform: Platform;
  versionString?: string;
  locales?: string[];
};

export type VersionLocalizationResource = z.infer<typeof VersionLocalization>;
export type AppInfoLocalizationResource = z.infer<typeof AppInfoLocalization>;

type AppInfoText = {
  state: string;
  localizations: AppInfoLocalizationResource['attributes'][];
};

export type Localizations = {
  app: AppSummary;
  version: { versionString: string; state: string };
  versionLocalizations: z.infer<typeof VersionLocalization>['attributes'][];
  appInfos: AppInfoText[];
};

export async function getLocalizations(
  client: AscClient,
  { bundleId, platform, versionString, locales }: LocalizationsRequest,
): Promise<Localizations> {
  const app = await findApp(client, bundleId);
  const version = pickVersion(await listVersions(client, app.appleId, platform), versionString);
  const [versionLocalizations, appInfos] = await Promise.all([
    readVersionLocalizations(client, version.id),
    currentAppInfos(client, app.appleId),
  ]);
  const versionTexts = versionLocalizations.map(({ attributes }) => attributes);
  const known = new Set([
    ...versionTexts.map(({ locale }) => locale),
    ...appInfos.flatMap(({ localizations }) => localizations.map(({ locale }) => locale)),
  ]);
  // 言語のコードを当て推量で渡されたとき（ja-JP など）に、空の結果を「文が無い」と読み違えさせない
  const unknown = (locales ?? []).filter((locale) => !known.has(locale));
  if (unknown.length > 0) {
    throw new Error(
      `言語 ${unknown.join('、')} の文はありません。ある言語は ${[...known].join('、')} です。`,
    );
  }
  const wanted = ({ locale }: { locale: string }) =>
    locales === undefined || locales.includes(locale);
  return {
    app,
    version: { versionString: version.status.versionString, state: version.status.state },
    versionLocalizations: versionTexts.filter(wanted),
    appInfos: appInfos.map(({ state, localizations }) => ({
      state,
      localizations: localizations.filter(wanted),
    })),
  };
}

function pickVersion(versions: Version[], versionString: string | undefined): Version {
  const current = versions.filter(isCurrent);
  const picked =
    versionString === undefined
      ? current[0]
      : versions.find(({ status }) => status.versionString === versionString);
  if (picked !== undefined) {
    return picked;
  }
  if (versionString === undefined) {
    throw new Error('この platform には、版がありません。');
  }
  const known = current
    .map(({ status }) => `${status.versionString}（${status.state}）`)
    .join('、');
  throw new Error(
    `版 ${versionString} はありません。${known === '' ? '' : `いまある版は ${known}です。`}`,
  );
}

async function currentAppInfos(client: AscClient, appleId: string): Promise<AppInfoText[]> {
  return Promise.all(
    (await listCurrentAppInfos(client, appleId)).map(async ({ id, state }) => ({
      state,
      localizations: (await readAppInfoLocalizations(client, id)).map(
        ({ attributes }) => attributes,
      ),
    })),
  );
}

export async function readVersionLocalizations(
  client: AscClient,
  versionId: string,
): Promise<VersionLocalizationResource[]> {
  const { data } = await client.getAll(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    { ...sparseFields(VersionLocalization), limit: '200' },
    { data: VersionLocalization },
  );
  return data;
}

export async function listCurrentAppInfos(
  client: AscClient,
  appleId: string,
): Promise<{ id: string; state: string }[]> {
  const { data } = await client.getAll(
    `/v1/apps/${appleId}/appInfos`,
    { ...sparseFields(AppInfo), limit: '200' },
    { data: AppInfo },
  );
  return data
    .filter(({ attributes }) => attributes.state !== REPLACED_APP_INFO_STATE)
    .map(({ id, attributes }) => ({ id, state: attributes.state }));
}

// 名前・カテゴリ・年齢制限などは、編集できる App 情報（次の版のために作られるもの）にしか書けない
export async function findEditableAppInfo(
  client: AscClient,
  appleId: string,
  what: string,
): Promise<{ id: string; state: string }> {
  const appInfos = await listCurrentAppInfos(client, appleId);
  const editable = appInfos.find(({ state }) => EDITABLE_APP_INFO_STATES.includes(state));
  if (editable === undefined) {
    throw new Error(
      `App 情報（${what}）に、いま編集できるものがありません（App 情報の状態: ${appInfos.map(({ state }) => state).join('、')}）。何も変えていません。`,
    );
  }
  return editable;
}

export async function readAppInfoLocalizations(
  client: AscClient,
  appInfoId: string,
): Promise<AppInfoLocalizationResource[]> {
  const { data } = await client.getAll(
    `/v1/appInfos/${appInfoId}/appInfoLocalizations`,
    { ...sparseFields(AppInfoLocalization), limit: '200' },
    { data: AppInfoLocalization },
  );
  return data;
}
