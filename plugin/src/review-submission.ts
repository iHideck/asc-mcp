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
    'No version can be submitted for App Review (a version that is being prepared for submission or was rejected). Prepare the next version with ensure_version.',
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
      `The App Review submission of version ${name} is being withdrawn. Call again after the withdrawal finishes (it takes a few minutes).`,
    );
  }
  if (isDistributed(version)) {
    throw new Error(`Version ${name} was already released.`);
  }
  if (mine === undefined && !isEditable(version)) {
    throw version.status.state === 'READY_FOR_REVIEW'
      ? new Error(
          `Version ${name} is in an App Review submission, but the submission was not found. Check it in App Store Connect.`,
        )
      : notEditableError(version);
  }
  await checkBuild(client, version);
  // 作りかけの提出があれば使う。やり直したときに、提出を二重に作らないため
  const reused = mine ?? submissions.find(({ state }) => state === 'READY_FOR_REVIEW');
  const others = reused?.items.filter(({ versionId }) => versionId !== version.id) ?? [];
  if (others.length > 0) {
    throw new Error(
      `The App Review submission contains ${others.length} other ${others.length === 1 ? 'item' : 'items'} (such as in-app purchases) besides version ${name}, and they would be submitted together. Check in App Store Connect whether to submit them together. Nothing was changed.`,
    );
  }
  const progress = trackProgress();
  const submissionId =
    reused?.id ??
    (await progress.write(
      'creating the App Review submission',
      'Created the App Review submission',
      () =>
        client.create(
          'reviewSubmissions',
          { platform: request.platform },
          { app: { type: 'apps', id: app.appleId } },
        ),
    ));
  const item = reused?.items.find(({ versionId }) => versionId === version.id);
  if (item === undefined) {
    await progress.write(
      `adding version ${name} to the submission`,
      `Added version ${name} to the submission`,
      () =>
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
      `marking the rejected version ${name} as resolved`,
      `Marked the rejected version ${name} as resolved`,
      () => client.update('reviewSubmissionItems', item.id, { resolved: true }),
    );
  }
  await progress.write(
    `submitting version ${name} for App Review`,
    `Submitted version ${name} for App Review`,
    () => client.update('reviewSubmissions', submissionId, { submitted: true }),
  );
  const after = await progress.read('reading the submitted version again', () =>
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
    'No version is submitted for App Review.',
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
        `Version ${name} is in an App Review submission that is not submitted yet. There is nothing to withdraw. Submit it with submit_for_review, or remove it from the submission in App Store Connect.`,
      );
    }
    if (isEditable(version)) {
      return result(app, request.platform, version, before, before);
    }
    throw new Error(
      `Version ${name} has no App Review submission to withdraw (version state: ${version.status.state}).`,
    );
  }
  const others = mine.items.filter(({ versionId }) => versionId !== version.id);
  if (others.length > 0) {
    throw new Error(
      `The App Review submission contains ${others.length} other ${others.length === 1 ? 'item' : 'items'} (such as in-app purchases) besides version ${name}, and they would be withdrawn together. Check them in App Store Connect. Nothing was changed.`,
    );
  }
  const progress = trackProgress();
  await progress.write(
    `withdrawing version ${name} from App Review`,
    `Withdrew version ${name} from App Review`,
    () => client.update('reviewSubmissions', mine.id, { canceled: true }),
  );
  const after = await progress.read('reading the withdrawn version again', () =>
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
      versionString === undefined ? noneMessage : `Version ${versionString} does not exist.`,
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
      `Version ${name} has no selected build. Select one with select_build before you submit.`,
    );
  }
  const { data, included } = await client.getPage(
    '/v1/builds',
    { ...sparseFields(Build, PreReleaseVersion), 'filter[id]': version.buildId },
    { data: Build, included: PreReleaseVersion },
  );
  const build = data[0];
  if (build === undefined) {
    throw new Error(`Could not read the selected build of version ${name}.`);
  }
  const number = build.attributes.version;
  const buildVersion = findIncluded(
    included,
    'preReleaseVersions',
    build.relationships.preReleaseVersion?.data,
  )?.attributes.version;
  if (buildVersion !== name) {
    throw new Error(
      `The selected build ${number} is for version ${buildVersion ?? 'unknown'}, which differs from the version number ${name}. Select a build for ${name} with select_build before you submit.`,
    );
  }
  const unusable = unusableReason(build);
  if (unusable !== undefined) {
    throw new Error(`You cannot submit the selected build ${number}. ${unusable}`);
  }
  if (build.attributes.usesNonExemptEncryption === null) {
    throw new Error(
      `The selected build ${number} has no export compliance (encryption use) answer. Answer it in App Store Connect before you submit.`,
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
    throw new Error('Could not read the version again.');
  }
  return { version: version.status.state, submission: submission?.attributes.state ?? null };
}
