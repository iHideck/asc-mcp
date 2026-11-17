import { findApp, type AppSummary } from './apps.ts';
import type { AscClient } from './client.ts';
import { trackProgress } from './progress.ts';
import {
  isDistributed,
  listVersions,
  type Platform,
  type Version,
  type VersionStatus,
} from './versions.ts';

export const PENDING_RELEASE_STATE = 'PENDING_DEVELOPER_RELEASE';

export const PHASED_RELEASE_ACTIONS = ['pause', 'resume', 'complete'] as const;
type PhasedReleaseAction = (typeof PHASED_RELEASE_ACTIONS)[number];

const PHASED_RELEASE_TARGETS = {
  pause: 'PAUSED',
  resume: 'ACTIVE',
  complete: 'COMPLETE',
} as const satisfies Record<PhasedReleaseAction, string>;

const RUNNING_PHASED_STATES: readonly string[] = ['ACTIVE', 'PAUSED'];

export type ReleaseRequest = {
  bundleId: string;
  platform: Platform;
  versionString?: string | undefined;
};

export type PhasedReleaseRequest = ReleaseRequest & { action: PhasedReleaseAction };

export type ReleaseResult = {
  app: AppSummary;
  platform: Platform;
  versionString: string;
  before: VersionStatus;
  after: VersionStatus;
};

export async function releaseVersion(
  client: AscClient,
  request: ReleaseRequest,
): Promise<ReleaseResult> {
  const app = await findApp(client, request.bundleId);
  const read = () => listVersions(client, app.appleId, request.platform);
  const versions = await read();
  const version = pick(
    versions,
    request.versionString,
    ({ status }) => status.state === PENDING_RELEASE_STATE,
    'No version is waiting for release (passed App Review and waiting for a manual release).',
  );
  const result = (after: VersionStatus): ReleaseResult => ({
    app,
    platform: request.platform,
    versionString: version.status.versionString,
    before: version.status,
    after,
  });
  if (isDistributed(version)) {
    return result(version.status);
  }
  if (version.status.state !== PENDING_RELEASE_STATE) {
    throw new Error(
      `You cannot release version ${version.status.versionString} because it is ${version.status.state}. You can release only a version that passed App Review and is waiting for a manual release (${PENDING_RELEASE_STATE}).`,
    );
  }
  const name = version.status.versionString;
  const progress = trackProgress();
  await progress.write(`releasing version ${name}`, `Released version ${name}`, () =>
    client.create(
      'appStoreVersionReleaseRequests',
      {},
      { appStoreVersion: { type: 'appStoreVersions', id: version.id } },
    ),
  );
  return result(
    await progress.read('reading the released version again', () => reread(read, version.id)),
  );
}

export async function setPhasedRelease(
  client: AscClient,
  request: PhasedReleaseRequest,
): Promise<ReleaseResult> {
  const app = await findApp(client, request.bundleId);
  const read = () => listVersions(client, app.appleId, request.platform);
  const versions = await read();
  const version = pick(
    versions,
    request.versionString,
    ({ status }) => RUNNING_PHASED_STATES.includes(status.phasedRelease?.state ?? ''),
    'No version has a phased release in progress.',
  );
  const name = version.status.versionString;
  const current = version.status.phasedRelease?.state;
  if (version.phasedReleaseId === null || current === undefined) {
    throw new Error(`Version ${name} has no phased release.`);
  }
  const target = PHASED_RELEASE_TARGETS[request.action];
  const result = (after: VersionStatus): ReleaseResult => ({
    app,
    platform: request.platform,
    versionString: name,
    before: version.status,
    after,
  });
  if (current === target) {
    return result(version.status);
  }
  if (!RUNNING_PHASED_STATES.includes(current)) {
    throw new Error(
      current === 'INACTIVE'
        ? `The phased release of version ${name} has not started yet. It starts when the version is released.`
        : `The phased release of version ${name} has already ended (${current}).`,
    );
  }
  const phasedReleaseId = version.phasedReleaseId;
  const progress = trackProgress();
  await progress.write(
    `setting the phased release of version ${name} to ${target}`,
    `Set the phased release of version ${name} to ${target}`,
    () =>
      client.update('appStoreVersionPhasedReleases', phasedReleaseId, {
        phasedReleaseState: target,
      }),
  );
  return result(
    await progress.read('reading the version again after the change', () =>
      reread(read, version.id),
    ),
  );
}

function pick(
  versions: Version[],
  versionString: string | undefined,
  fits: (version: Version) => boolean,
  noneMessage: string,
): Version {
  const version =
    versionString === undefined
      ? versions.find(fits)
      : versions.find(({ status }) => status.versionString === versionString);
  if (version === undefined) {
    throw new Error(
      versionString === undefined ? noneMessage : `Version ${versionString} does not exist.`,
    );
  }
  return version;
}

async function reread(read: () => Promise<Version[]>, id: string): Promise<VersionStatus> {
  const version = (await read()).find((candidate) => candidate.id === id);
  if (version === undefined) {
    throw new Error('Could not read the version again.');
  }
  return version.status;
}
