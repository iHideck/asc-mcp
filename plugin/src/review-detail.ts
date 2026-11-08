import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import { sparseFields, type AscClient, type Attributes } from './client.ts';
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
  const read = () =>
    client.getOne(
      `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`,
      sparseFields(ReviewDetail),
      ReviewDetail,
    );
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
      'この版には、審査の情報がまだありません。審査に出す前に、連絡先（名前・電話番号・メール）を App Store Connect の画面で入れてください。',
    ];
  }
  const summary = summarize(detail);
  const { attributes } = detail;
  return [
    summary === null || summary.missingContact.length === 0
      ? undefined
      : `審査の連絡先（${summary.missingContact.map((field) => CONTACT_FIELDS[field]).join('・')}）が入っていません。審査に出す前に、App Store Connect の画面で入れてください。`,
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
