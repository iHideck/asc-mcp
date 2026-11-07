import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { findIncluded, sparseFields, toMany, toOne, type AscClient } from './client.ts';
import { isCurrent, listVersions, type Platform, type VersionStatus } from './versions.ts';

const LATEST_BUILDS = 5;

const Build = z.object({
  type: z.literal('builds'),
  id: z.string(),
  attributes: z.object({
    version: z.string(),
    uploadedDate: z.string(),
    expired: z.boolean(),
    processingState: z.string(),
  }),
  relationships: z.object({
    preReleaseVersion: toOne,
    buildBetaDetail: toOne,
    betaGroups: toMany,
    buildUpload: toOne,
  }),
});

const PreReleaseVersion = z.object({
  type: z.literal('preReleaseVersions'),
  id: z.string(),
  attributes: z.object({ version: z.string() }),
});

const BuildBetaDetail = z.object({
  type: z.literal('buildBetaDetails'),
  id: z.string(),
  attributes: z.object({ internalBuildState: z.string(), externalBuildState: z.string() }),
});

const BetaGroup = z.object({
  type: z.literal('betaGroups'),
  id: z.string(),
  attributes: z.object({ name: z.string(), isInternalGroup: z.boolean() }),
});

const UploadMessage = z.object({ code: z.string(), description: z.string() });

const BuildUpload = z.object({
  type: z.literal('buildUploads'),
  id: z.string(),
  attributes: z.object({
    state: z.object({
      errors: z.array(UploadMessage).nullish(),
      warnings: z.array(UploadMessage).nullish(),
    }),
  }),
});

type UploadMessage = z.infer<typeof UploadMessage>;

export type BuildStatus = {
  version: string | null;
  buildNumber: string;
  uploadedDate: string;
  processingState: string;
  expired: boolean;
  testFlight: { internal: string; external: string } | null;
  betaGroups: { name: string; internal: boolean }[];
  uploadIssues: { errors: UploadMessage[]; warnings: UploadMessage[] } | null;
};

export type ReleaseStatus = {
  app: AppSummary;
  platform: Platform;
  builds: BuildStatus[];
  versions: VersionStatus[];
};

export async function getReleaseStatus(
  client: AscClient,
  bundleId: string,
  platform: Platform,
): Promise<ReleaseStatus> {
  const app = await findApp(client, bundleId);
  const [builds, versions] = await Promise.all([
    latestBuilds(client, app.appleId, platform),
    listVersions(client, app.appleId, platform),
  ]);
  return {
    app,
    platform,
    builds,
    versions: versions.filter(isCurrent).map((version) => version.status),
  };
}

async function latestBuilds(
  client: AscClient,
  appleId: string,
  platform: Platform,
): Promise<BuildStatus[]> {
  const { data, included } = await client.getPage(
    '/v1/builds',
    {
      ...sparseFields(Build, PreReleaseVersion, BuildBetaDetail, BetaGroup, BuildUpload),
      'filter[app]': appleId,
      'filter[preReleaseVersion.platform]': platform,
      sort: '-uploadedDate',
      limit: String(LATEST_BUILDS),
      'limit[betaGroups]': '50',
    },
    {
      data: Build,
      included: z.discriminatedUnion('type', [
        PreReleaseVersion,
        BuildBetaDetail,
        BetaGroup,
        BuildUpload,
      ]),
    },
  );
  return data.map(({ attributes, relationships }) => {
    const preRelease = findIncluded(
      included,
      'preReleaseVersions',
      relationships.preReleaseVersion.data,
    );
    const beta = findIncluded(included, 'buildBetaDetails', relationships.buildBetaDetail.data);
    const upload = findIncluded(included, 'buildUploads', relationships.buildUpload.data);
    return {
      version: preRelease?.attributes.version ?? null,
      buildNumber: attributes.version,
      uploadedDate: attributes.uploadedDate,
      processingState: attributes.processingState,
      expired: attributes.expired,
      testFlight:
        beta === undefined
          ? null
          : {
              internal: beta.attributes.internalBuildState,
              external: beta.attributes.externalBuildState,
            },
      betaGroups: (relationships.betaGroups.data ?? []).flatMap((identifier) => {
        const group = findIncluded(included, 'betaGroups', identifier);
        return group === undefined
          ? []
          : [{ name: group.attributes.name, internal: group.attributes.isInternalGroup }];
      }),
      uploadIssues:
        upload === undefined
          ? null
          : {
              errors: upload.attributes.state.errors ?? [],
              warnings: upload.attributes.state.warnings ?? [],
            },
    };
  });
}
