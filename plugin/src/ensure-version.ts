import { findApp, type AppSummary } from './apps.ts';
import type { AscClient, Attributes } from './client.ts';
import {
  isEditable,
  isFirstRelease,
  listVersions,
  type Platform,
  type VersionStatus,
} from './versions.ts';

export const RELEASE_TYPES = ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'] as const;

export type EnsureVersionRequest = {
  bundleId: string;
  platform: Platform;
  versionString: string;
  releaseType?: (typeof RELEASE_TYPES)[number] | undefined;
  earliestReleaseDate?: string | undefined;
  phasedRelease?: boolean | undefined;
};

type Release =
  | { releaseType: 'MANUAL' | 'AFTER_APPROVAL'; earliestReleaseDate: null }
  | { releaseType: 'SCHEDULED'; earliestReleaseDate: string };

export type Skipped = { field: string; reason: string };

export type EnsuredVersion = {
  app: AppSummary;
  platform: Platform;
  before: VersionStatus | null;
  after: VersionStatus;
  skipped: Skipped[];
};

export async function ensureVersion(
  client: AscClient,
  request: EnsureVersionRequest,
): Promise<EnsuredVersion> {
  const release = parseRelease(request);
  const app = await findApp(client, request.bundleId);
  const versions = await listVersions(client, app.appleId, request.platform);
  const firstRelease = isFirstRelease(versions);
  const phasedRelease = firstRelease ? undefined : request.phasedRelease;
  const skipped =
    firstRelease && request.phasedRelease !== undefined
      ? [{ field: 'phasedRelease', reason: '初めて出す版には、段階的リリースがありません' }]
      : [];
  const result = (before: VersionStatus | null, after: VersionStatus): EnsuredVersion => ({
    app,
    platform: request.platform,
    before,
    after,
    skipped,
  });
  const existing =
    versions.find(({ status }) => status.versionString === request.versionString) ??
    versions.find(isEditable);

  let id: string;
  if (existing === undefined) {
    id = await client.create(
      'appStoreVersions',
      {
        platform: request.platform,
        versionString: request.versionString,
        ...releaseChanges(null, release),
      },
      { app: { type: 'apps', id: app.appleId } },
    );
  } else {
    const changes = {
      ...(existing.status.versionString === request.versionString
        ? {}
        : { versionString: request.versionString }),
      ...releaseChanges(existing.status, release),
    };
    const togglesPhased =
      phasedRelease !== undefined && phasedRelease !== (existing.phasedReleaseId !== null);
    if (Object.keys(changes).length === 0 && !togglesPhased) {
      return result(existing.status, existing.status);
    }
    if (!isEditable(existing)) {
      throw new Error(
        `版 ${existing.status.versionString} は、いま ${existing.status.state} なので変えられません。変えられるのは、提出の準備中か、却下されたあとの版です。`,
      );
    }
    id = existing.id;
    if (Object.keys(changes).length > 0) {
      await client.update('appStoreVersions', id, changes);
    }
  }

  const phasedReleaseId = existing?.phasedReleaseId ?? null;
  if (phasedRelease === true && phasedReleaseId === null) {
    await client.create(
      'appStoreVersionPhasedReleases',
      { phasedReleaseState: 'INACTIVE' },
      { appStoreVersion: { type: 'appStoreVersions', id } },
    );
  } else if (phasedRelease === false && phasedReleaseId !== null) {
    await client.remove('appStoreVersionPhasedReleases', phasedReleaseId);
  }

  const after = (await listVersions(client, app.appleId, request.platform)).find(
    (version) => version.id === id,
  );
  if (after === undefined) {
    throw new Error(`版 ${request.versionString} を変えたあと、読み直せませんでした。`);
  }
  return result(existing?.status ?? null, after.status);
}

function parseRelease({
  releaseType,
  earliestReleaseDate,
}: EnsureVersionRequest): Release | undefined {
  if (releaseType === 'SCHEDULED') {
    if (earliestReleaseDate === undefined) {
      throw new Error(
        'releaseType を SCHEDULED にするときは、公開する日時（earliestReleaseDate）が要ります。',
      );
    }
    return { releaseType, earliestReleaseDate };
  }
  if (earliestReleaseDate !== undefined) {
    throw new Error('earliestReleaseDate は、releaseType を SCHEDULED にするときだけ使えます。');
  }
  return releaseType === undefined ? undefined : { releaseType, earliestReleaseDate: null };
}

function releaseChanges(current: VersionStatus | null, release: Release | undefined): Attributes {
  if (release === undefined) {
    return {};
  }
  return {
    ...(current?.releaseType === release.releaseType ? {} : { releaseType: release.releaseType }),
    ...(sameInstant(current?.earliestReleaseDate ?? null, release.earliestReleaseDate)
      ? {}
      : { earliestReleaseDate: release.earliestReleaseDate }),
  };
}

// 同じ日時でも、時差の書き方（+09:00 と Z）で文字が変わる
function sameInstant(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
}
