import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { AscApiError, sparseFields, type AscClient, type Attributes } from './client.ts';
import { trackProgress } from './progress.ts';
import { listVersions, pickEditableVersion, type Platform } from './versions.ts';

// 審査用アカウントのパスワード（demoAccountPassword）は、ここに足さない。足すと Apple から読んで、結果に出してしまう
const ReviewDetail = z.object({
  type: z.literal('appStoreReviewDetails'),
  id: z.string(),
  attributes: z.object({
    contactFirstName: z.string().nullable(),
    contactLastName: z.string().nullable(),
    contactPhone: z.string().nullable(),
    contactEmail: z.string().nullable(),
    demoAccountName: z.string().nullable(),
    demoAccountRequired: z.boolean().nullable(),
    notes: z.string().nullable(),
  }),
});

type ReviewDetailResource = z.infer<typeof ReviewDetail>;

const CONTACT_FIELDS = {
  contactFirstName: '名',
  contactLastName: '姓',
  contactPhone: '電話番号',
  contactEmail: 'メール',
} as const;

type ContactField = keyof typeof CONTACT_FIELDS;
const CONTACT_NAMES = Object.keys(CONTACT_FIELDS) as ContactField[];

// 連絡先を写す元は、そのアプリの新しい版から、この数だけ見る
const SOURCE_VERSIONS_TO_SEARCH = 5;

export type ReviewDetailSummary = {
  notes: string | null;
  demoAccountRequired: boolean | null;
  demoAccountName: string | null;
  missingContact: ContactField[];
};

export type SetReviewDetailRequest = {
  bundleId: string;
  platform: Platform;
  versionString?: string | undefined;
  notes?: string | null | undefined;
  demoAccountRequired?: boolean | undefined;
};

export type SetReviewDetailResult = {
  app: AppSummary;
  platform: Platform;
  versionString: string;
  before: ReviewDetailSummary | null;
  after: ReviewDetailSummary | null;
  warnings: string[];
};

export async function setReviewDetail(
  client: AscClient,
  request: SetReviewDetailRequest,
): Promise<SetReviewDetailResult> {
  const app = await findApp(client, request.bundleId);
  const version = pickEditableVersion(
    await listVersions(client, app.appleId, request.platform),
    request.versionString,
  );
  const { versionString } = version.status;
  const read = () => readReviewDetail(client, version.id);
  const before = await read();
  const notes = request.notes === '' ? null : request.notes;
  const changes: Attributes = {
    ...(notes === undefined || notes === (before?.attributes.notes ?? null) ? {} : { notes }),
    ...(request.demoAccountRequired === undefined ||
    request.demoAccountRequired === before?.attributes.demoAccountRequired
      ? {}
      : { demoAccountRequired: request.demoAccountRequired }),
  };
  let after = before;
  if (Object.keys(changes).length > 0) {
    const what = [
      changes.notes === undefined ? undefined : '審査メモ',
      changes.demoAccountRequired === undefined ? undefined : 'サインインが要るか',
    ]
      .filter((part) => part !== undefined)
      .join('・');
    const progress = trackProgress();
    await progress.write(
      `版 ${versionString} の${what}を入れる`,
      `版 ${versionString} の${what}を入れました`,
      async () => {
        if (before === null) {
          await client.create('appStoreReviewDetails', changes, {
            appStoreVersion: { type: 'appStoreVersions', id: version.id },
          });
        } else {
          await client.update('appStoreReviewDetails', before.id, changes);
        }
      },
    );
    after = await progress.read('入れた審査の情報を読み直す', read);
  }
  return {
    app,
    platform: request.platform,
    versionString,
    before: summarize(before),
    after: summarize(after),
    warnings: warningsFor(after, notes, request.demoAccountRequired),
  };
}

export type CopyReviewContactRequest = {
  bundleId: string;
  platform: Platform;
  versionString?: string | undefined;
  fromBundleId: string;
};

export type CopyReviewContactResult = {
  app: AppSummary;
  platform: Platform;
  versionString: string;
  from: { bundleId: string; versionString: string };
  copied: ContactField[];
  before: ReviewDetailSummary | null;
  after: ReviewDetailSummary | null;
};

export async function copyReviewContact(
  client: AscClient,
  request: CopyReviewContactRequest,
): Promise<CopyReviewContactResult> {
  if (request.fromBundleId === request.bundleId) {
    throw new Error('連絡先を写す元と写す先が、同じアプリです。');
  }
  const app = await findApp(client, request.bundleId);
  const version = pickEditableVersion(
    await listVersions(client, app.appleId, request.platform),
    request.versionString,
  );
  const { versionString } = version.status;
  const source = await findApp(client, request.fromBundleId);
  const contact = await sourceContact(client, source, request.platform);
  const read = () => readReviewDetail(client, version.id);
  const before = await read();
  const copied = CONTACT_NAMES.filter(
    (field) => before?.attributes[field] !== contact.values[field],
  );
  let after = before;
  if (copied.length > 0) {
    const changes: Attributes = Object.fromEntries(
      copied.map((field) => [field, contact.values[field]]),
    );
    const progress = trackProgress();
    await progress.write(
      `版 ${versionString} に、審査の連絡先を写す`,
      `版 ${versionString} に、審査の連絡先を写しました`,
      () =>
        hidingValues(Object.values(contact.values), async () => {
          if (before === null) {
            await client.create('appStoreReviewDetails', changes, {
              appStoreVersion: { type: 'appStoreVersions', id: version.id },
            });
          } else {
            await client.update('appStoreReviewDetails', before.id, changes);
          }
        }),
    );
    after = await progress.read('写した審査の情報を読み直す', read);
  }
  return {
    app,
    platform: request.platform,
    versionString,
    from: { bundleId: source.bundleId, versionString: contact.versionString },
    copied,
    before: summarize(before),
    after: summarize(after),
  };
}

export function readReviewDetail(
  client: AscClient,
  versionId: string,
): Promise<ReviewDetailResource | null> {
  return client.getOne(
    `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
    sparseFields(ReviewDetail),
    ReviewDetail,
  );
}

async function sourceContact(
  client: AscClient,
  source: AppSummary,
  platform: Platform,
): Promise<{ versionString: string; values: Record<ContactField, string> }> {
  const versions = await listVersions(client, source.appleId, platform);
  for (const version of versions.slice(0, SOURCE_VERSIONS_TO_SEARCH)) {
    const detail = await readReviewDetail(client, version.id);
    const values = CONTACT_NAMES.map((field) => [field, detail?.attributes[field] ?? ''] as const);
    if (values.every(([, value]) => value !== '')) {
      return {
        versionString: version.status.versionString,
        values: Object.fromEntries(values) as Record<ContactField, string>,
      };
    }
  }
  throw new Error(
    `${source.bundleId} の新しい ${SOURCE_VERSIONS_TO_SEARCH} つの版に、そろった審査の連絡先がありません。何も変えていません。`,
  );
}

// 連絡先の中身は、エラーの文にも出さない。Apple のエラーや、書かない設定のエラーは、送った中身を含むことがある
async function hidingValues<T>(values: string[], work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const forms = values
      .filter((value) => value !== '')
      .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
    const message = forms.reduce(
      (text, value) => text.split(value).join('（伏せた）'),
      error instanceof Error ? error.message : String(error),
    );
    throw error instanceof AscApiError
      ? new AscApiError(error.status, message)
      : new Error(message);
  }
}

function summarize(detail: ReviewDetailResource | null): ReviewDetailSummary | null {
  if (detail === null) {
    return null;
  }
  const { attributes } = detail;
  return {
    notes: attributes.notes,
    demoAccountRequired: attributes.demoAccountRequired,
    demoAccountName: attributes.demoAccountName,
    missingContact: (Object.keys(CONTACT_FIELDS) as ContactField[]).filter(
      (field) => (attributes[field] ?? '') === '',
    ),
  };
}

function warningsFor(
  detail: ReviewDetailResource | null,
  notes: string | null | undefined,
  demoAccountRequired: boolean | undefined,
): string[] {
  if (detail === null) {
    return [
      'この版には、審査の情報がまだありません。審査に出す前に、連絡先（名前・電話番号・メール）を、copy_review_contact でほかのアプリの版から写すか、App Store Connect の画面で入れてください。',
    ];
  }
  const summary = summarize(detail);
  const { attributes } = detail;
  return [
    summary === null || summary.missingContact.length === 0
      ? undefined
      : `審査の連絡先（${summary.missingContact.map((field) => CONTACT_FIELDS[field]).join('・')}）が入っていません。審査に出す前に、copy_review_contact でほかのアプリの版から写すか、App Store Connect の画面で入れてください。`,
    attributes.demoAccountRequired === true && (attributes.demoAccountName ?? '') === ''
      ? 'サインインが要るとしていますが、審査用のアカウントが入っていません。App Store Connect の画面で入れてください。'
      : undefined,
    notes === undefined || attributes.notes === notes
      ? undefined
      : 'App Store Connect の値が、頼んだものと違います: 審査メモ（Apple が直したかもしれません）',
    demoAccountRequired === undefined || attributes.demoAccountRequired === demoAccountRequired
      ? undefined
      : 'App Store Connect の値が、頼んだものと違います: サインインが要るか',
  ].filter((text) => text !== undefined);
}
