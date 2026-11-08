import { z } from 'zod';
import { findIncluded, sparseFields, toOne, type AscClient } from './client.ts';

export const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const REPLACED_VERSION_STATE = 'REPLACED_WITH_NEW_VERSION';

export const EDITABLE_VERSION_STATES: readonly string[] = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
];

export const DISTRIBUTED_VERSION_STATES: readonly string[] = [
  'PROCESSING_FOR_DISTRIBUTION',
  'READY_FOR_DISTRIBUTION',
  REPLACED_VERSION_STATE,
];

const AppStoreVersion = z.object({
  type: z.literal('appStoreVersions'),
  id: z.string(),
  attributes: z.object({
    versionString: z.string(),
    appVersionState: z.string(),
    releaseType: z.string().nullable(),
    earliestReleaseDate: z.string().nullable(),
    createdDate: z.string().nullable(),
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
  createdDate: string | null;
  build: { buildNumber: string; uploadedDate: string } | null;
  phasedRelease: {
    state: string;
    startDate: string | null;
    currentDayNumber: number | null;
  } | null;
};

export type Version = {
  id: string;
  buildId: string | null;
  phasedReleaseId: string | null;
  status: VersionStatus;
};

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
      const build = findIncluded(included, 'builds', relationships.build?.data);
      const phased = findIncluded(
        included,
        'appStoreVersionPhasedReleases',
        relationships.appStoreVersionPhasedRelease?.data,
      );
      return {
        id,
        buildId: relationships.build?.data?.id ?? null,
        phasedReleaseId: relationships.appStoreVersionPhasedRelease?.data?.id ?? null,
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
    .sort((a, b) => createdTime(b) - createdTime(a));
}

// 作った日の無い版は、いちばん古い版として扱う
function createdTime({ status }: Version): number {
  return status.createdDate === null ? 0 : Date.parse(status.createdDate);
}

export function isCurrent(version: Version): boolean {
  return version.status.state !== REPLACED_VERSION_STATE;
}

export function isEditable(version: Version): boolean {
  return EDITABLE_VERSION_STATES.includes(version.status.state);
}

export function isDistributed(version: Version): boolean {
  return DISTRIBUTED_VERSION_STATES.includes(version.status.state);
}

export function isFirstRelease(versions: Version[]): boolean {
  return !versions.some(isDistributed);
}

export function notEditableError({ status }: Version): Error {
  return new Error(
    `版 ${status.versionString} は、いま ${status.state} なので変えられません。変えられるのは、提出の準備中か、却下されたあとの版です。審査中の版は、審査から外すと変えられるようになります。`,
  );
}

export function pickEditableVersion(
  versions: Version[],
  versionString: string | undefined,
): Version {
  const version =
    versionString === undefined
      ? versions.find(isEditable)
      : versions.find(({ status }) => status.versionString === versionString);
  if (version === undefined) {
    throw new Error(
      versionString === undefined
        ? '編集できる版（提出の準備中か、却下されたあとの版）がありません。ensure_version で、次に出す版を用意してください。'
        : `版 ${versionString} はありません。ensure_version で、次に出す版を用意してください。`,
    );
  }
  if (!isEditable(version)) {
    throw notEditableError(version);
  }
  return version;
}
