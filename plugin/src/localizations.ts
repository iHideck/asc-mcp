import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { findIncluded, sparseFields, toMany, type AscClient } from './client.ts';
import { isCurrent, listVersions, type Platform, type Version } from './versions.ts';

export const REPLACED_APP_INFO_STATE = 'REPLACED_WITH_NEW_INFO';

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
  relationships: z.object({ appInfoLocalizations: toMany }),
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

export type Localizations = {
  app: AppSummary;
  version: { versionString: string; state: string };
  versionLocalizations: z.infer<typeof VersionLocalization>['attributes'][];
  appInfos: {
    state: string;
    localizations: z.infer<typeof AppInfoLocalization>['attributes'][];
  }[];
};

export async function getLocalizations(
  client: AscClient,
  { bundleId, platform, versionString, locales }: LocalizationsRequest,
): Promise<Localizations> {
  const app = await findApp(client, bundleId);
  const version = pickVersion(await listVersions(client, app.appleId, platform), versionString);
  const [versionLocalizations, appInfos] = await Promise.all([
    client.getAll(
      `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`,
      {
        ...sparseFields(VersionLocalization),
        ...(locales === undefined ? {} : { 'filter[locale]': locales.join(',') }),
        limit: '200',
      },
      { data: VersionLocalization },
    ),
    client.getAll(
      `/v1/apps/${app.appleId}/appInfos`,
      { ...sparseFields(AppInfo, AppInfoLocalization), 'limit[appInfoLocalizations]': '50' },
      { data: AppInfo, included: AppInfoLocalization },
    ),
  ]);
  return {
    app,
    version: { versionString: version.status.versionString, state: version.status.state },
    versionLocalizations: versionLocalizations.data.map(({ attributes }) => attributes),
    appInfos: appInfos.data
      .filter(({ attributes }) => attributes.state !== REPLACED_APP_INFO_STATE)
      .map(({ attributes, relationships }) => ({
        state: attributes.state,
        localizations: (relationships.appInfoLocalizations.data ?? [])
          .flatMap((identifier) => {
            const localization = findIncluded(
              appInfos.included,
              'appInfoLocalizations',
              identifier,
            );
            return localization === undefined ? [] : [localization.attributes];
          })
          .filter(({ locale }) => locales === undefined || locales.includes(locale)),
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
