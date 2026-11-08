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
      ? [{ field: 'phasedRelease', reason: '初めて出す版には、段階的リリースがありません' }]
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
    progress.read('変えた版を読み直す', async () => {
      const version = (await read()).find((candidate) => candidate.id === id);
      if (version === undefined) {
        throw new Error(`版 ${request.versionString} を、読み直せませんでした。`);
      }
      return version;
    });

  let id: string;
  let phasedReleaseId: string | null;
  if (target === undefined) {
    const blocking = versions.find((version) => !isEditable(version) && !isDistributed(version));
    if (blocking !== undefined) {
      throw new Error(
        `版 ${blocking.status.versionString} が、いま ${blocking.status.state} なので、新しい版はまだ作れません。その版が公開されるか、審査から外して編集できるようになってから、もう一度呼んでください。`,
      );
    }
    id = await progress.write(
      `版 ${request.versionString} を作る`,
      `版 ${request.versionString} を作りました`,
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
        `版 ${target.status.versionString} の${what}変える`,
        `版 ${target.status.versionString} の${what}変えました`,
        () => client.update('appStoreVersions', target.id, changes),
      );
    }
    if (renamed && target.buildId !== null) {
      warnings.push(
        `版の番号を ${target.status.versionString} から ${request.versionString} に変えましたが、選んであるビルド${target.status.build === null ? '' : ` ${target.status.build.buildNumber}`} は、前の番号のときのビルドです。select_build で、${request.versionString} のビルドを選び直してください。選び直すまで、審査に出さないでください。`,
      );
    }
    id = target.id;
    phasedReleaseId = target.phasedReleaseId;
  }

  const versionId = id;
  if (phasedRelease === true && phasedReleaseId === null) {
    await progress.write('段階的リリースを付ける', '段階的リリースを付けました', () =>
      client.create(
        'appStoreVersionPhasedReleases',
        { phasedReleaseState: 'INACTIVE' },
        { appStoreVersion: { type: 'appStoreVersions', id: versionId } },
      ),
    );
  } else if (phasedRelease === false && phasedReleaseId !== null) {
    const removing = phasedReleaseId;
    await progress.write('段階的リリースを外す', '段階的リリースを外しました', () =>
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
        'releaseType を SCHEDULED にするときは、公開する日時（earliestReleaseDate）が要ります。',
      );
    }
    const time = Date.parse(earliestReleaseDate);
    if (time % HOUR_MS !== 0) {
      throw new Error('公開する日時（earliestReleaseDate）は、正時（分と秒が 0）にしてください。');
    }
    if (time <= now) {
      throw new Error('公開する日時（earliestReleaseDate）が、もう過ぎています。');
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

function describeChanges(changes: Attributes): string {
  return [
    changes.versionString === undefined ? undefined : `番号を ${String(changes.versionString)} に`,
    changes.releaseType === undefined
      ? undefined
      : `公開のしかたを ${String(changes.releaseType)} に`,
    changes.releaseType === undefined && typeof changes.earliestReleaseDate === 'string'
      ? `公開の日時を ${changes.earliestReleaseDate} に`
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join('、');
}

function usedNumberError(match: Version, versions: Version[]): Error {
  const newest = versions.find(isDistributed) ?? match;
  return new Error(
    `版 ${match.status.versionString} は、公開したことのある番号です（${match.status.state}）。次に出す版は、${newest.status.versionString} より大きい番号にしてください。`,
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
      : `版の番号が ${status.versionString} です（頼んだのは ${request.versionString}）`,
    release === undefined || status.releaseType === release.releaseType
      ? undefined
      : `公開のしかたが ${String(status.releaseType)} です（頼んだのは ${release.releaseType}）`,
    release === undefined || sameInstant(status.earliestReleaseDate, release.earliestReleaseDate)
      ? undefined
      : `公開の日時が ${String(status.earliestReleaseDate)} です（頼んだのは ${String(release.earliestReleaseDate)}）`,
    phasedRelease === undefined || phasedRelease === (after.phasedReleaseId !== null)
      ? undefined
      : `段階的リリースが${after.phasedReleaseId === null ? '付いていません' : '付いています'}（頼んだのは${phasedRelease ? '使う' : '使わない'}）`,
  ]
    .filter((text) => text !== undefined)
    .map((text) => `App Store Connect の値が、頼んだものと違います: ${text}`);
}
