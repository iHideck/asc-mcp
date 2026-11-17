import { findApp, type AppSummary } from './apps.ts';
import { Build, PreReleaseVersion, unusableReason, type BuildResource } from './builds.ts';
import { findIncluded, sparseFields, type AscClient } from './client.ts';
import { trackProgress } from './progress.ts';
import {
  listVersions,
  pickEditableVersion,
  type Platform,
  type VersionStatus,
} from './versions.ts';

const ENCRYPTION_WARNING =
  'The build has no export compliance answer (encryption use). Answer it in App Store Connect before you submit for App Review. If you add ITSAppUsesNonExemptEncryption to Info.plist, later builds do not need the answer.';

export type SelectBuildRequest = {
  bundleId: string;
  platform: Platform;
  versionString?: string | undefined;
  buildNumber: string;
};

export type SelectedBuild = {
  app: AppSummary;
  platform: Platform;
  versionString: string;
  before: VersionStatus['build'];
  after: VersionStatus['build'];
  warnings: string[];
};

export async function selectBuild(
  client: AscClient,
  request: SelectBuildRequest,
): Promise<SelectedBuild> {
  const app = await findApp(client, request.bundleId);
  const version = pickEditableVersion(
    await listVersions(client, app.appleId, request.platform),
    request.versionString,
  );
  const { versionString } = version.status;
  const builds = await buildsOf(client, app.appleId, request.platform, versionString);
  const build = builds.find(({ attributes }) => attributes.version === request.buildNumber);
  if (build === undefined) {
    throw new Error(
      builds.length === 0
        ? `Version ${versionString} has no builds. You can select only a build whose version (CFBundleShortVersionString) matches the version number. get_release_status shows the versions of the uploaded builds.`
        : `Version ${versionString} has no build ${request.buildNumber}. The builds for this version are ${builds.map(({ attributes }) => attributes.version).join(', ')}.`,
    );
  }
  const unusable = unusableReason(build);
  if (unusable !== undefined) {
    throw new Error(`Cannot select build ${request.buildNumber}. ${unusable}`);
  }
  const warnings = build.attributes.usesNonExemptEncryption === null ? [ENCRYPTION_WARNING] : [];
  const result = (
    before: VersionStatus['build'],
    after: VersionStatus['build'],
  ): SelectedBuild => ({ app, platform: request.platform, versionString, before, after, warnings });
  if (version.buildId === build.id) {
    return result(version.status.build, version.status.build);
  }
  const progress = trackProgress();
  await progress.write(
    `selecting build ${request.buildNumber} for version ${versionString}`,
    `Selected build ${request.buildNumber} for version ${versionString}`,
    () =>
      client.setRelationship('appStoreVersions', version.id, 'build', {
        type: 'builds',
        id: build.id,
      }),
  );
  const after = await progress.read('rereading the version', async () => {
    const found = (await listVersions(client, app.appleId, request.platform)).find(
      ({ id }) => id === version.id,
    );
    if (found === undefined) {
      throw new Error(`Could not reread version ${versionString}.`);
    }
    return found;
  });
  if (after.buildId !== build.id) {
    warnings.push(
      `The value in App Store Connect differs from the requested value: the selected build is ${after.status.build?.buildNumber ?? 'none'} (requested: ${request.buildNumber})`,
    );
  }
  return result(version.status.build, after.status.build);
}

async function buildsOf(
  client: AscClient,
  appleId: string,
  platform: Platform,
  versionString: string,
): Promise<BuildResource[]> {
  const { data, included } = await client.getAll(
    '/v1/builds',
    {
      ...sparseFields(Build, PreReleaseVersion),
      'filter[app]': appleId,
      'filter[preReleaseVersion.platform]': platform,
      'filter[preReleaseVersion.version]': versionString,
      sort: '-uploadedDate',
      limit: '200',
    },
    { data: Build, included: PreReleaseVersion },
  );
  // filter[preReleaseVersion.version] が、版の番号の完全な一致で選ぶかは、Apple の文書に書いていない
  return data.filter(
    ({ relationships }) =>
      findIncluded(included, 'preReleaseVersions', relationships.preReleaseVersion?.data)
        ?.attributes.version === versionString,
  );
}
