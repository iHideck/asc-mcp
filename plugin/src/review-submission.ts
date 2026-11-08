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
  attributes: z.object({ state: z.string(), submittedDate: z.string().nullable() }),
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

export const OPEN_SUBMISSION_STATES: readonly string[] = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'UNRESOLVED_ISSUES',
];

export const SUBMITTED_VERSION_STATES: readonly string[] = [
  'READY_FOR_REVIEW',
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
];

const CANCELABLE_SUBMISSION_STATES: readonly string[] = ['WAITING_FOR_REVIEW', 'IN_REVIEW'];

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

type Submission = { id: string; state: string; versionIds: string[] };

export async function submitForReview(
  client: AscClient,
  request: ReviewRequest,
): Promise<ReviewResult> {
  const app = await findApp(client, request.bundleId);
  const versions = await listVersions(client, app.appleId, request.platform);
  const version =
    request.versionString === undefined
      ? versions.find(
          (candidate) =>
            isEditable(candidate) || SUBMITTED_VERSION_STATES.includes(candidate.status.state),
        )
      : versions.find(({ status }) => status.versionString === request.versionString);
  if (version === undefined) {
    throw new Error(
      request.versionString === undefined
        ? '審査に出せる版（提出の準備中か、却下されたあとの版）がありません。ensure_version で、次に出す版を用意してください。'
        : `版 ${request.versionString} はありません。`,
    );
  }
  const submissions = await openSubmissions(client, app.appleId, request.platform);
  const mine = submissions.find(({ versionIds }) => versionIds.includes(version.id));
  const before = { version: version.status.state, submission: mine?.state ?? null };
  if (SUBMITTED_VERSION_STATES.includes(version.status.state)) {
    return result(app, request.platform, version, before, before);
  }
  if (isDistributed(version)) {
    throw new Error(`版 ${version.status.versionString} は、公開したことのある版です。`);
  }
  if (!isEditable(version)) {
    throw notEditableError(version);
  }
  await checkBuild(client, version);
  // 作りかけの提出（または、却下されて直しを待つ提出）があれば使う。やり直したときに、提出を二重に作らないため
  const reusable = mine ?? submissions.find(({ state }) => state === 'READY_FOR_REVIEW');
  const name = version.status.versionString;
  const progress = trackProgress();
  const submissionId =
    reusable?.id ??
    (await progress.write('審査への提出を作る', '審査への提出を作りました', () =>
      client.create(
        'reviewSubmissions',
        { platform: request.platform },
        { app: { type: 'apps', id: app.appleId } },
      ),
    ));
  if (!(reusable?.versionIds.includes(version.id) ?? false)) {
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
  const version =
    request.versionString === undefined
      ? versions.find(({ status }) => SUBMITTED_VERSION_STATES.includes(status.state))
      : versions.find(({ status }) => status.versionString === request.versionString);
  if (version === undefined) {
    throw new Error(
      request.versionString === undefined
        ? '審査に出している版がありません。'
        : `版 ${request.versionString} はありません。`,
    );
  }
  const submissions = await openSubmissions(client, app.appleId, request.platform);
  const mine = submissions.find(({ versionIds }) => versionIds.includes(version.id));
  const before = { version: version.status.state, submission: mine?.state ?? null };
  if (mine === undefined || !CANCELABLE_SUBMISSION_STATES.includes(mine.state)) {
    if (isEditable(version)) {
      return result(app, request.platform, version, before, before);
    }
    throw new Error(
      `版 ${version.status.versionString} には、取り下げられる審査への提出がありません（版の状態: ${version.status.state}）。`,
    );
  }
  const name = version.status.versionString;
  const progress = trackProgress();
  await progress.write(`版 ${name} の審査を取り下げる`, `版 ${name} の審査を取り下げました`, () =>
    client.update('reviewSubmissions', mine.id, { canceled: true }),
  );
  const after = await progress.read('取り下げた版を読み直す', () =>
    readState(client, app.appleId, request.platform, version.id, mine.id),
  );
  return result(app, request.platform, version, before, after);
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
        versionIds: items.data.flatMap(({ relationships }) => {
          const versionId = relationships.appStoreVersion?.data?.id;
          return versionId === undefined ? [] : [versionId];
        }),
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
