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
  contactFirstName: 'first name',
  contactLastName: 'last name',
  contactPhone: 'phone number',
  contactEmail: 'email',
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
      changes.notes === undefined ? undefined : 'the review notes',
      changes.demoAccountRequired === undefined ? undefined : 'whether sign-in is required',
    ]
      .filter((part) => part !== undefined)
      .join(' and ');
    const progress = trackProgress();
    await progress.write(
      `setting ${what} for version ${versionString}`,
      `Set ${what} for version ${versionString}`,
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
    after = await progress.read('reading the App Review information again after the change', read);
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
    throw new Error('The source and destination of the contact are the same app.');
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
      `copying the App Review contact to version ${versionString}`,
      `Copied the App Review contact to version ${versionString}`,
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
    after = await progress.read('reading the App Review information again after the copy', read);
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
    `None of the ${SOURCE_VERSIONS_TO_SEARCH} newest versions of ${source.bundleId} has a complete App Review contact. Nothing was changed.`,
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
      (text, value) => text.split(value).join('(hidden)'),
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
      'This version has no App Review information yet. Before you submit for App Review, copy the contact (name, phone number, and email) from a version of another app with copy_review_contact, or enter it in App Store Connect.',
    ];
  }
  const summary = summarize(detail);
  const { attributes } = detail;
  return [
    summary === null || summary.missingContact.length === 0
      ? undefined
      : `The App Review contact is missing ${summary.missingContact.map((field) => CONTACT_FIELDS[field]).join(', ')}. Before you submit for App Review, copy the contact from a version of another app with copy_review_contact, or enter it in App Store Connect.`,
    attributes.demoAccountRequired === true && (attributes.demoAccountName ?? '') === ''
      ? 'Sign-in is required, but no demo account is set. Enter one in App Store Connect.'
      : undefined,
    notes === undefined || attributes.notes === notes
      ? undefined
      : 'The value in App Store Connect differs from the request: review notes (Apple might have modified them)',
    demoAccountRequired === undefined || attributes.demoAccountRequired === demoAccountRequired
      ? undefined
      : 'The value in App Store Connect differs from the request: whether sign-in is required',
  ].filter((text) => text !== undefined);
}
