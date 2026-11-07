import { z } from 'zod';
import { findIncluded, sparseFields, toOne, type AscClient } from './client.ts';

export const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const REPLACED_VERSION_STATE = 'REPLACED_WITH_NEW_VERSION';

const AppStoreVersion = z.object({
  type: z.literal('appStoreVersions'),
  id: z.string(),
  attributes: z.object({
    versionString: z.string(),
    appVersionState: z.string(),
    releaseType: z.string().nullable(),
    earliestReleaseDate: z.string().nullable(),
    createdDate: z.string(),
  }),
  relationships: z.object({ build: toOne, appStoreVersionPhasedRelease: toOne }),
});

const Build = z.object({
  type: z.literal('builds'),
  id: z.string(),
  attributes: z.object({ version: z.string(), uploadedDate: z.string() }),
});

const PhasedRelease = z.object({
  type: z.literal('appStoreVersionPhasedReleases'),
  id: z.string(),
  attributes: z.object({
    phasedReleaseState: z.string(),
    startDate: z.string().nullable(),
    currentDayNumber: z.number().nullable(),
  }),
});

export type VersionStatus = {
  versionString: string;
  state: string;
  releaseType: string | null;
  earliestReleaseDate: string | null;
  createdDate: string;
  build: { buildNumber: string; uploadedDate: string } | null;
  phasedRelease: {
    state: string;
    startDate: string | null;
    currentDayNumber: number | null;
  } | null;
};

export type Version = { id: string; status: VersionStatus };

// 作った日の新しい順に返す
export async function listVersions(
  client: AscClient,
  appleId: string,
  platform: Platform,
): Promise<Version[]> {
  const { data, included } = await client.getAll(
    `/v1/apps/${appleId}/appStoreVersions`,
    {
      ...sparseFields(AppStoreVersion, Build, PhasedRelease),
      'filter[platform]': platform,
      limit: '200',
    },
    { data: AppStoreVersion, included: z.discriminatedUnion('type', [Build, PhasedRelease]) },
  );
  return data
    .map(({ id, attributes, relationships }) => {
      const build = findIncluded(included, 'builds', relationships.build.data);
      const phased = findIncluded(
        included,
        'appStoreVersionPhasedReleases',
        relationships.appStoreVersionPhasedRelease.data,
      );
      return {
        id,
        status: {
          versionString: attributes.versionString,
          state: attributes.appVersionState,
          releaseType: attributes.releaseType,
          earliestReleaseDate: attributes.earliestReleaseDate,
          createdDate: attributes.createdDate,
          build:
            build === undefined
              ? null
              : {
                  buildNumber: build.attributes.version,
                  uploadedDate: build.attributes.uploadedDate,
                },
          phasedRelease:
            phased === undefined
              ? null
              : {
                  state: phased.attributes.phasedReleaseState,
                  startDate: phased.attributes.startDate,
                  currentDayNumber: phased.attributes.currentDayNumber,
                },
        },
      };
    })
    .sort((a, b) => Date.parse(b.status.createdDate) - Date.parse(a.status.createdDate));
}

export function isCurrent(version: Version): boolean {
  return version.status.state !== REPLACED_VERSION_STATE;
}
