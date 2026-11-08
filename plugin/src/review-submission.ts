import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { Build, PreReleaseVersion, unusableReason } from './builds.ts';
import { findIncluded, sparseFields, toOne, type AscClient } from './client.ts';
import { trackProgress } from './progress.ts';
import {
  isDistributed,
  isEditable,
  listVersions,
  notEditableError,
  type Platform,
  type Version,
} from './versions.ts';

const ReviewSubmission = z.object({
  type: z.literal('reviewSubmissions'),
  id: z.string(),
  attributes: z.object({ state: z.string() }),
});

const SubmissionItem = z.object({
  type: z.literal('reviewSubmissionItems'),
  id: z.string(),
  attributes: z.object({ state: z.string() }),
  relationships: z.object({ appStoreVersion: toOne }),
});

const ItemVersion = z.object({
  type: z.literal('appStoreVersions'),
  id: z.string(),
  attributes: z.object({ versionString: z.string() }),
});

// 読む提出の状態。CANCELING も読むのは、取り下げの最中に呼ばれたとき、そうと分かるようにするため
export const OPEN_SUBMISSION_STATES: readonly string[] = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'UNRESOLVED_ISSUES',
  'CANCELING',
];

// 審査に出してある提出の状態。版の状態は、出したあと遅れて変わるので、提出の状態で決める
export const SENT_SUBMISSION_STATES: readonly string[] = ['WAITING_FOR_REVIEW', 'IN_REVIEW'];

// 版の READY_FOR_REVIEW は、提出に入れたが、まだ出していない状態
const IN_SUBMISSION_VERSION_STATES: readonly string[] = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
];

export type ReviewRequest = {
  bundleId: string;
  platform: Platform;
  versionString?: string | undefined;
};

export type ReviewState = { version: string; submission: string | null };

export type ReviewResult = {
  app: AppSummary;
  platform: Platform;
  versionString: string;
  buildNumber: string | null;
  before: ReviewState;
  after: ReviewState;
};

type Item = { id: string; state: string; versionId: string | null };
type Submission = { id: string; state: string; items: Item[] };

export async function submitForReview(
  client: AscClient,
  request: ReviewRequest,
): Promise<ReviewResult> {
  const app = await findApp(client, request.bundleId);
  const versions = await listVersions(client, app.appleId, request.platform);
  const version = pickVersion(
    versions,
    request.versionString,
    (candidate) =>
      isEditable(candidate) || IN_SUBMISSION_VERSION_STATES.includes(candidate.status.state),
    '審査に出せる版（提出の準備中か、却下されたあとの版）がありません。ensure_version で、次に出す版を用意してください。',
  );
  const name = version.status.versionString;
  const submissions = await openSubmissions(client, app.appleId, request.platform);
  const mine = submissionOf(submissions, version.id);
  const before = { version: version.status.state, submission: mine?.state ?? null };
  const sent =
    mine === undefined
      ? SENT_SUBMISSION_STATES.includes(version.status.state)
      : SENT_SUBMISSION_STATES.includes(mine.state);
  if (sent) {
    return result(app, request.platform, version, before, before);
  }
  if (mine?.state === 'CANCELING') {
    throw new Error(
      `版 ${name} の審査は、取り下げの最中です。取り下げが終わってから（数分かかります）、もう一度呼んでください。`,
    );
  }
  if (isDistributed(version)) {
    throw new Error(`版 ${name} は、公開したことのある版です。`);
  }
  if (mine === undefined && !isEditable(version)) {
    throw version.status.state === 'READY_FOR_REVIEW'
      ? new Error(
          `版 ${name} は審査への提出に入っていますが、その提出が見つかりません。App Store Connect で確かめてください。`,
        )
      : notEditableError(version);
  }
  await checkBuild(client, version);
  // 作りかけの提出があれば使う。やり直したときに、提出を二重に作らないため
  const reused = mine ?? submissions.find(({ state }) => state === 'READY_FOR_REVIEW');
  const others = reused?.items.filter(({ versionId }) => versionId !== version.id) ?? [];
  if (others.length > 0) {
    throw new Error(
      `審査への提出に、版 ${name} のほかに ${others.length} 件（App 内課金など）が入っていて、出すと一緒に審査に出ます。一緒に出すかを、App Store Connect で確かめてください。何も変えていません。`,
    );
  }
  const progress = trackProgress();
  const submissionId =
    reused?.id ??
    (await progress.write('審査への提出を作る', '審査への提出を作りました', () =>
      client.create(
        'reviewSubmissions',
        { platform: request.platform },
        { app: { type: 'apps', id: app.appleId } },
      ),
    ));
  const item = reused?.items.find(({ versionId }) => versionId === version.id);
  if (item === undefined) {
    await progress.write(`提出に版 ${name} を入れる`, `提出に版 ${name} を入れました`, () =>
      client.create(
        'reviewSubmissionItems',
        {},
        {
          reviewSubmission: { type: 'reviewSubmissions', id: submissionId },
          appStoreVersion: { type: 'appStoreVersions', id: version.id },
        },
      ),
    );
  } else if (item.state === 'REJECTED') {
    // 却下された中身は、直したことにしてからでないと、出し直せない
    await progress.write(
      `却下された版 ${name} を、直したことにする`,
      `却下された版 ${name} を、直したことにしました`,
      () => client.update('reviewSubmissionItems', item.id, { resolved: true }),
    );
  }
  await progress.write(`版 ${name} を審査に出す`, `版 ${name} を審査に出しました`, () =>
    client.update('reviewSubmissions', submissionId, { submitted: true }),
  );
  const after = await progress.read('出した版を読み直す', () =>
    readState(client, app.appleId, request.platform, version.id, submissionId),
  );
  return result(app, request.platform, version, before, after);
}

export async function cancelReview(
  client: AscClient,
  request: ReviewRequest,
): Promise<ReviewResult> {
  const app = await findApp(client, request.bundleId);
  const versions = await listVersions(client, app.appleId, request.platform);
  const submissions = await openSubmissions(client, app.appleId, request.platform);
  const canceling = submissions
    .filter(({ state }) => state === 'CANCELING')
    .flatMap(({ items }) => items.map(({ versionId }) => versionId));
  const version = pickVersion(
    versions,
    request.versionString,
    (candidate) => IN_SUBMISSION_VERSION_STATES.includes(candidate.status.state),
    '審査に出している版がありません。',
    (candidate) => canceling.includes(candidate.id) || isEditable(candidate),
  );
  const name = version.status.versionString;
  const mine = submissionOf(submissions, version.id);
  const before = { version: version.status.state, submission: mine?.state ?? null };
  if (mine?.state === 'CANCELING') {
    return result(app, request.platform, version, before, before);
  }
  if (mine === undefined || !SENT_SUBMISSION_STATES.includes(mine.state)) {
    if (mine?.state === 'READY_FOR_REVIEW') {
      throw new Error(
        `版 ${name} は、まだ出していない審査への提出に入っています。取り下げるものはありません。submit_for_review で出すか、App Store Connect で提出から外してください。`,
      );
    }
    if (isEditable(version)) {
      return result(app, request.platform, version, before, before);
    }
    throw new Error(
      `版 ${name} には、取り下げられる審査への提出がありません（版の状態: ${version.status.state}）。`,
    );
  }
  const others = mine.items.filter(({ versionId }) => versionId !== version.id);
  if (others.length > 0) {
    throw new Error(
      `審査への提出に、版 ${name} のほかに ${others.length} 件（App 内課金など）が入っていて、取り下げると一緒に取り下げます。App Store Connect で確かめてください。何も変えていません。`,
    );
  }
  const progress = trackProgress();
  await progress.write(`版 ${name} の審査を取り下げる`, `版 ${name} の審査を取り下げました`, () =>
    client.update('reviewSubmissions', mine.id, { canceled: true }),
  );
  const after = await progress.read('取り下げた版を読み直す', () =>
    readState(client, app.appleId, request.platform, version.id, mine.id),
  );
  return result(app, request.platform, version, before, after);
}

function pickVersion(
  versions: Version[],
  versionString: string | undefined,
  fits: (version: Version) => boolean,
  noneMessage: string,
  fallback: (version: Version) => boolean = () => false,
): Version {
  const version =
    versionString === undefined
      ? (versions.find(fits) ?? versions.find(fallback))
      : versions.find(({ status }) => status.versionString === versionString);
  if (version === undefined) {
    throw new Error(
      versionString === undefined ? noneMessage : `版 ${versionString} はありません。`,
    );
  }
  return version;
}

function submissionOf(submissions: Submission[], versionId: string): Submission | undefined {
  return submissions.find(({ items }) => items.some((item) => item.versionId === versionId));
}

function result(
  app: AppSummary,
  platform: Platform,
  version: Version,
  before: ReviewState,
  after: ReviewState,
): ReviewResult {
  return {
    app,
    platform,
    versionString: version.status.versionString,
    buildNumber: version.status.build?.buildNumber ?? null,
    before,
    after,
  };
}

async function openSubmissions(
  client: AscClient,
  appleId: string,
  platform: Platform,
): Promise<Submission[]> {
  const { data } = await client.getAll(
    `/v1/apps/${appleId}/reviewSubmissions`,
    {
      ...sparseFields(ReviewSubmission),
      'filter[platform]': platform,
      'filter[state]': OPEN_SUBMISSION_STATES.join(','),
      limit: '200',
    },
    { data: ReviewSubmission },
  );
  return Promise.all(
    data.map(async ({ id, attributes }) => {
      const items = await client.getAll(
        `/v1/reviewSubmissions/${id}/items`,
        { ...sparseFields(SubmissionItem, ItemVersion), limit: '200' },
        { data: SubmissionItem, included: ItemVersion },
      );
      return {
        id,
        state: attributes.state,
        items: items.data
          .filter(({ attributes }) => attributes.state !== 'REMOVED')
          .map(({ id: itemId, attributes, relationships }) => ({
            id: itemId,
            state: attributes.state,
            versionId: relationships.appStoreVersion?.data?.id ?? null,
          })),
      };
    }),
  );
}

async function checkBuild(client: AscClient, version: Version): Promise<void> {
  const name = version.status.versionString;
  if (version.buildId === null) {
    throw new Error(
      `版 ${name} に、ビルドが選んでありません。select_build で選んでから出してください。`,
    );
  }
  const { data, included } = await client.getPage(
    '/v1/builds',
    { ...sparseFields(Build, PreReleaseVersion), 'filter[id]': version.buildId },
    { data: Build, included: PreReleaseVersion },
  );
  const build = data[0];
  if (build === undefined) {
    throw new Error(`版 ${name} に選んであるビルドを、読めませんでした。`);
  }
  const number = build.attributes.version;
  const buildVersion = findIncluded(
    included,
    'preReleaseVersions',
    build.relationships.preReleaseVersion?.data,
  )?.attributes.version;
  if (buildVersion !== name) {
    throw new Error(
      `選んであるビルド ${number} の版は ${buildVersion ?? '不明'} で、版の番号 ${name} と違います。select_build で、${name} のビルドを選び直してから出してください。`,
    );
  }
  const unusable = unusableReason(build);
  if (unusable !== undefined) {
    throw new Error(`選んであるビルド ${number} は出せません。${unusable}`);
  }
  if (build.attributes.usesNonExemptEncryption === null) {
    throw new Error(
      `選んであるビルド ${number} に、輸出コンプライアンス（暗号の使用）の答えがありません。App Store Connect で答えてから出してください。`,
    );
  }
}

async function readState(
  client: AscClient,
  appleId: string,
  platform: Platform,
  versionId: string,
  submissionId: string,
): Promise<ReviewState> {
  const [versions, submission] = await Promise.all([
    listVersions(client, appleId, platform),
    client.getOne(
      `/v1/reviewSubmissions/${submissionId}`,
      sparseFields(ReviewSubmission),
      ReviewSubmission,
    ),
  ]);
  const version = versions.find(({ id }) => id === versionId);
  if (version === undefined) {
    throw new Error('版を、読み直せませんでした。');
  }
  return { version: version.status.state, submission: submission?.attributes.state ?? null };
}
