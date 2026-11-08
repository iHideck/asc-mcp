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
    '公開を待っている版（審査が通り、手動の公開を待っている版）がありません。',
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
      `版 ${version.status.versionString} は、いま ${version.status.state} なので公開できません。公開できるのは、審査が通り、手動の公開を待っている版（${PENDING_RELEASE_STATE}）です。`,
    );
  }
  const name = version.status.versionString;
  const progress = trackProgress();
  await progress.write(`版 ${name} を公開する`, `版 ${name} を公開しました`, () =>
    client.create(
      'appStoreVersionReleaseRequests',
      {},
      { appStoreVersion: { type: 'appStoreVersions', id: version.id } },
    ),
  );
  return result(await progress.read('公開した版を読み直す', () => reread(read, version.id)));
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
    '段階的リリースを進めている版がありません。',
  );
  const name = version.status.versionString;
  const current = version.status.phasedRelease?.state;
  if (version.phasedReleaseId === null || current === undefined) {
    throw new Error(`版 ${name} には、段階的リリースがありません。`);
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
        ? `版 ${name} の段階的リリースは、まだ始まっていません。版が公開されると始まります。`
        : `版 ${name} の段階的リリースは、もう終わっています（${current}）。`,
    );
  }
  const phasedReleaseId = version.phasedReleaseId;
  const progress = trackProgress();
  await progress.write(
    `版 ${name} の段階的リリースを ${target} にする`,
    `版 ${name} の段階的リリースを ${target} にしました`,
    () =>
      client.update('appStoreVersionPhasedReleases', phasedReleaseId, {
        phasedReleaseState: target,
      }),
  );
  return result(await progress.read('変えた版を読み直す', () => reread(read, version.id)));
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
      versionString === undefined ? noneMessage : `版 ${versionString} はありません。`,
    );
  }
  return version;
}

async function reread(read: () => Promise<Version[]>, id: string): Promise<VersionStatus> {
  const version = (await read()).find((candidate) => candidate.id === id);
  if (version === undefined) {
    throw new Error('版を、読み直せませんでした。');
  }
  return version.status;
}
