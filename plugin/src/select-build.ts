import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { findIncluded, sparseFields, toOne, type AscClient } from './client.ts';
import { trackProgress } from './progress.ts';
import {
  listVersions,
  pickEditableVersion,
  type Platform,
  type VersionStatus,
} from './versions.ts';

const Build = z.object({
  type: z.literal('builds'),
  id: z.string(),
  attributes: z.object({
    version: z.string(),
    uploadedDate: z.string(),
    expired: z.boolean(),
    processingState: z.string(),
    buildAudienceType: z.string().nullable(),
    usesNonExemptEncryption: z.boolean().nullable(),
  }),
  relationships: z.object({ preReleaseVersion: toOne }),
});

const PreReleaseVersion = z.object({
  type: z.literal('preReleaseVersions'),
  id: z.string(),
  attributes: z.object({ version: z.string() }),
});

const ENCRYPTION_WARNING =
  '輸出コンプライアンス（暗号の使用）の答えが、このビルドにありません。審査に出す前に、App Store Connect で答えてください。Info.plist に ITSAppUsesNonExemptEncryption を入れると、次のビルドからは答えが要りません。';

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
        ? `版 ${versionString} のビルドがありません。選べるのは、ビルドの版（CFBundleShortVersionString）が版の番号と同じビルドだけです。上げたビルドの版は、get_release_status で見られます。`
        : `版 ${versionString} のビルド ${request.buildNumber} はありません。この版のビルドは ${builds.map(({ attributes }) => attributes.version).join('・')} です。`,
    );
  }
  const unusable = unusableReason(build);
  if (unusable !== undefined) {
    throw new Error(`ビルド ${request.buildNumber} は選べません。${unusable}`);
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
    `版 ${versionString} にビルド ${request.buildNumber} を選ぶ`,
    `版 ${versionString} にビルド ${request.buildNumber} を選びました`,
    () =>
      client.setRelationship('appStoreVersions', version.id, 'build', {
        type: 'builds',
        id: build.id,
      }),
  );
  const after = await progress.read('選んだ版を読み直す', async () => {
    const found = (await listVersions(client, app.appleId, request.platform)).find(
      ({ id }) => id === version.id,
    );
    if (found === undefined) {
      throw new Error(`版 ${versionString} を、読み直せませんでした。`);
    }
    return found;
  });
  if (after.buildId !== build.id) {
    warnings.push(
      `App Store Connect の値が、頼んだものと違います: 選んであるビルドが ${after.status.build?.buildNumber ?? '無し'} です（頼んだのは ${request.buildNumber}）`,
    );
  }
  return result(version.status.build, after.status.build);
}

async function buildsOf(
  client: AscClient,
  appleId: string,
  platform: Platform,
  versionString: string,
): Promise<z.infer<typeof Build>[]> {
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

function unusableReason({ attributes }: z.infer<typeof Build>): string | undefined {
  if (attributes.processingState !== 'VALID') {
    return `処理の状態が ${attributes.processingState} です。VALID になってから選んでください。`;
  }
  if (attributes.expired) {
    return '期限が切れています。';
  }
  if (attributes.buildAudienceType === 'INTERNAL_ONLY') {
    return 'TestFlight の内部テスト専用のビルドなので、App Store には出せません。';
  }
  return undefined;
}
