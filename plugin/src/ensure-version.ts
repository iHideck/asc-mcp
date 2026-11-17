import { findApp, type AppSummary } from './apps.ts';
import type { AscClient, Attributes } from './client.ts';
import { trackProgress } from './progress.ts';
import {
  isDistributed,
  isEditable,
  isFirstRelease,
  listVersions,
  notEditableError,
  type Platform,
  type Version,
  type VersionStatus,
} from './versions.ts';

export const RELEASE_TYPES = ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'] as const;

const HOUR_MS = 60 * 60 * 1000;

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
  warnings: string[];
};

export async function ensureVersion(
  client: AscClient,
  request: EnsureVersionRequest,
  now: () => number = Date.now,
): Promise<EnsuredVersion> {
  const release = parseRelease(request, now());
  const app = await findApp(client, request.bundleId);
  const read = () => listVersions(client, app.appleId, request.platform);
  const versions = await read();
  const firstRelease = isFirstRelease(versions);
  const phasedRelease = firstRelease ? undefined : request.phasedRelease;
  const skipped =
    firstRelease && request.phasedRelease !== undefined
      ? [
          {
            field: 'phasedRelease',
            reason: 'The first version of an app cannot use phased release',
          },
        ]
      : [];
  const warnings: string[] = [];
  const result = (before: VersionStatus | null, after: VersionStatus): EnsuredVersion => ({
    app,
    platform: request.platform,
    before,
    after,
    skipped,
    warnings,
  });
  const match = versions.find(({ status }) => status.versionString === request.versionString);
  if (match !== undefined && isDistributed(match)) {
    throw usedNumberError(match, versions);
  }
  const target = match ?? versions.find(isEditable);
  const progress = trackProgress();
  const reread = (id: string) =>
    progress.read('reading the version again after the change', async () => {
      const version = (await read()).find((candidate) => candidate.id === id);
      if (version === undefined) {
        throw new Error(`Could not read version ${request.versionString} again.`);
      }
      return version;
    });

  let id: string;
  let phasedReleaseId: string | null;
  if (target === undefined) {
    const blocking = versions.find((version) => !isEditable(version) && !isDistributed(version));
    if (blocking !== undefined) {
      throw new Error(
        `You cannot create a new version yet because version ${blocking.status.versionString} is ${blocking.status.state}. Call again after that version is released, or after you remove it from App Review so that it is editable.`,
      );
    }
    id = await progress.write(
      `creating version ${request.versionString}`,
      `Created version ${request.versionString}`,
      () =>
        client.create(
          'appStoreVersions',
          {
            platform: request.platform,
            versionString: request.versionString,
            ...releaseChanges(null, release),
          },
          { app: { type: 'apps', id: app.appleId } },
        ),
    );
    // 作った版に、Apple が前の版の設定を写しているかもしれないので、段階的リリースは作ったあとの実物で決める
    phasedReleaseId = phasedRelease === undefined ? null : (await reread(id)).phasedReleaseId;
  } else {
    const renamed = target.status.versionString !== request.versionString;
    const changes: Attributes = {
      ...(renamed ? { versionString: request.versionString } : {}),
      ...releaseChanges(target.status, release),
    };
    const togglesPhased =
      phasedRelease !== undefined && phasedRelease !== (target.phasedReleaseId !== null);
    if (Object.keys(changes).length === 0 && !togglesPhased) {
      return result(target.status, target.status);
    }
    if (!isEditable(target)) {
      throw notEditableError(target);
    }
    if (Object.keys(changes).length > 0) {
      const what = describeChanges(changes);
      await progress.write(
        `setting ${what} for version ${target.status.versionString}`,
        `Set ${what} for version ${target.status.versionString}`,
        () => client.update('appStoreVersions', target.id, changes),
      );
    }
    if (renamed && target.buildId !== null) {
      warnings.push(
        `Changed the version number from ${target.status.versionString} to ${request.versionString}, but the selected build${target.status.build === null ? '' : ` ${target.status.build.buildNumber}`} was built for the previous number. Select a build for ${request.versionString} with select_build. Do not submit for App Review until you select it.`,
      );
    }
    id = target.id;
    phasedReleaseId = target.phasedReleaseId;
  }

  const versionId = id;
  if (phasedRelease === true && phasedReleaseId === null) {
    await progress.write('turning on phased release', 'Turned on phased release', () =>
      client.create(
        'appStoreVersionPhasedReleases',
        { phasedReleaseState: 'INACTIVE' },
        { appStoreVersion: { type: 'appStoreVersions', id: versionId } },
      ),
    );
  } else if (phasedRelease === false && phasedReleaseId !== null) {
    const removing = phasedReleaseId;
    await progress.write('turning off phased release', 'Turned off phased release', () =>
      client.remove('appStoreVersionPhasedReleases', removing),
    );
  }

  const after = await reread(versionId);
  warnings.push(...differences(after, request, release, phasedRelease));
  return result(target?.status ?? null, after.status);
}

function parseRelease(
  { releaseType, earliestReleaseDate }: EnsureVersionRequest,
  now: number,
): Release | undefined {
  if (releaseType === 'SCHEDULED') {
    if (earliestReleaseDate === undefined) {
      throw new Error(
        'Pass a release date (earliestReleaseDate) when you set releaseType to SCHEDULED.',
      );
    }
    const time = Date.parse(earliestReleaseDate);
    if (time % HOUR_MS !== 0) {
      throw new Error(
        'The release date (earliestReleaseDate) must be on the hour (0 minutes and 0 seconds).',
      );
    }
    if (time <= now) {
      throw new Error('The release date (earliestReleaseDate) is in the past.');
    }
    return { releaseType, earliestReleaseDate };
  }
  if (earliestReleaseDate !== undefined) {
    throw new Error('You can pass earliestReleaseDate only when you set releaseType to SCHEDULED.');
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

function describeChanges(changes: Attributes): string {
  return [
    changes.versionString === undefined
      ? undefined
      : `the version number to ${String(changes.versionString)}`,
    changes.releaseType === undefined
      ? undefined
      : `the release type to ${String(changes.releaseType)}`,
    changes.releaseType === undefined && typeof changes.earliestReleaseDate === 'string'
      ? `the release date to ${changes.earliestReleaseDate}`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' and ');
}

function usedNumberError(match: Version, versions: Version[]): Error {
  const newest = versions.find(isDistributed) ?? match;
  return new Error(
    `Version ${match.status.versionString} was already released (${match.status.state}). Use a number greater than ${newest.status.versionString} for the next version.`,
  );
}

function differences(
  after: Version,
  request: EnsureVersionRequest,
  release: Release | undefined,
  phasedRelease: boolean | undefined,
): string[] {
  const { status } = after;
  return [
    status.versionString === request.versionString
      ? undefined
      : `the version number is ${status.versionString} (requested: ${request.versionString})`,
    release === undefined || status.releaseType === release.releaseType
      ? undefined
      : `the release type is ${String(status.releaseType)} (requested: ${release.releaseType})`,
    release === undefined || sameInstant(status.earliestReleaseDate, release.earliestReleaseDate)
      ? undefined
      : `the release date is ${String(status.earliestReleaseDate)} (requested: ${String(release.earliestReleaseDate)})`,
    phasedRelease === undefined || phasedRelease === (after.phasedReleaseId !== null)
      ? undefined
      : `phased release is ${after.phasedReleaseId === null ? 'off' : 'on'} (requested: ${phasedRelease ? 'on' : 'off'})`,
  ]
    .filter((text) => text !== undefined)
    .map((text) => `The value in App Store Connect differs from the request: ${text}`);
}
