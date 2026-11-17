import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import type { AscClient, Attributes } from './client.ts';
import {
  findEditableAppInfo,
  readAppInfoLocalizations,
  readVersionLocalizations,
} from './localizations.ts';
import { trackProgress } from './progress.ts';
import { isFirstRelease, listVersions, pickEditableVersion, type Platform } from './versions.ts';

const RESOURCES = ['appStoreVersionLocalizations', 'appInfoLocalizations'] as const;
type Resource = (typeof RESOURCES)[number];

type FieldRule = { label: string; resource: Resource; limit?: number; url?: true; note?: string };

// キーワードの上限は、Apple の文書では100バイトだが、実際は文字の数で数える（日本語で191バイトのキーワードが公開されている）
const FIELDS = {
  description: { label: 'Description', resource: 'appStoreVersionLocalizations', limit: 4000 },
  keywords: {
    label: 'Keywords',
    resource: 'appStoreVersionLocalizations',
    limit: 100,
    note: 'Separate keywords with commas',
  },
  promotionalText: {
    label: 'Promotional Text',
    resource: 'appStoreVersionLocalizations',
    limit: 170,
  },
  whatsNew: {
    label: "What's New",
    resource: 'appStoreVersionLocalizations',
    limit: 4000,
    note: "Skipped for the first release, which has no What's New text",
  },
  supportUrl: { label: 'Support URL', resource: 'appStoreVersionLocalizations', url: true },
  marketingUrl: {
    label: 'Marketing URL',
    resource: 'appStoreVersionLocalizations',
    url: true,
  },
  name: { label: 'Name', resource: 'appInfoLocalizations', limit: 30 },
  subtitle: { label: 'Subtitle', resource: 'appInfoLocalizations', limit: 30 },
  privacyPolicyUrl: {
    label: 'Privacy Policy URL',
    resource: 'appInfoLocalizations',
    url: true,
  },
} satisfies Record<string, FieldRule>;

type FieldName = keyof typeof FIELDS;
const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

function rule(name: FieldName): FieldRule {
  return FIELDS[name];
}

export const localizationInput = z.object({
  locale: z
    .string()
    .min(1)
    .describe('The locale code, such as ja or en-US. get_localizations shows the codes.'),
  ...(Object.fromEntries(
    FIELD_NAMES.map((name) => [
      name,
      z
        .string()
        .nullable()
        .optional()
        .describe(describeField(rule(name))),
    ]),
  ) as Record<FieldName, z.ZodOptional<z.ZodNullable<z.ZodString>>>),
});

export type LocalizationInput = z.infer<typeof localizationInput>;

export type SetLocalizationsRequest = {
  bundleId: string;
  platform: Platform;
  versionString?: string | undefined;
  localizations: LocalizationInput[];
};

export type LocalizationChange = {
  locale: string;
  field: FieldName;
  before: string | null;
  after: string | null;
};

export type SkippedField = { locale: string; field: FieldName; reason: string };

export type SetLocalizationsResult = {
  app: AppSummary;
  platform: Platform;
  version: { versionString: string; state: string };
  changes: LocalizationChange[];
  skipped: SkippedField[];
  warnings: string[];
};

type Wanted = { locale: string; values: Partial<Record<FieldName, string | null>> };
type Current = { id: string; locale: string; values: Partial<Record<FieldName, string | null>> };
type Snapshot = Record<Resource, Current[]>;
type Write = {
  resource: Resource;
  id: string;
  locale: string;
  fields: FieldName[];
  attributes: Attributes;
};

export async function setLocalizations(
  client: AscClient,
  request: SetLocalizationsRequest,
): Promise<SetLocalizationsResult> {
  checkTexts(request.localizations);
  const app = await findApp(client, request.bundleId);
  const versions = await listVersions(client, app.appleId, request.platform);
  const version = pickEditableVersion(versions, request.versionString);
  const firstRelease = isFirstRelease(versions);
  const skipped: SkippedField[] = [];
  const wanted = request.localizations.map((entry): Wanted => {
    const values: Wanted['values'] = {};
    for (const name of FIELD_NAMES) {
      const value = entry[name];
      if (value === undefined) {
        continue;
      }
      if (name === 'whatsNew' && firstRelease) {
        skipped.push({
          locale: entry.locale,
          field: name,
          reason: "The first release has no What's New text",
        });
        continue;
      }
      values[name] = value === '' ? null : value;
    }
    return { locale: entry.locale, values };
  });
  const needsAppInfo = wanted.some(({ values }) =>
    FIELD_NAMES.some(
      (name) => values[name] !== undefined && rule(name).resource === 'appInfoLocalizations',
    ),
  );
  const read = () => readSnapshot(client, app.appleId, version.id, needsAppInfo);
  const before = await read();
  const writes = plan(wanted, before);
  const progress = trackProgress();
  for (const { resource, id, locale, fields, attributes } of writes) {
    const what = `${fields.map((field) => rule(field).label).join(', ')} for ${locale}`;
    await progress.write(`updating the ${what}`, `Updated the ${what}`, () =>
      client.update(resource, id, attributes),
    );
  }
  const after =
    writes.length === 0 ? before : await progress.read('rereading the changed text', read);
  const changes = writes.flatMap((write) =>
    write.fields.map((field) => ({
      locale: write.locale,
      field,
      before: valueIn(before, write, field),
      after: valueIn(after, write, field),
    })),
  );
  return {
    app,
    platform: request.platform,
    version: { versionString: version.status.versionString, state: version.status.state },
    changes,
    skipped,
    warnings: changes.flatMap(({ locale, field, after: stored }) =>
      stored === (wanted.find((entry) => entry.locale === locale)?.values[field] ?? null)
        ? []
        : [
            `The value in App Store Connect differs from the requested value: ${rule(field).label} for ${locale} (Apple may have corrected it. Check it with get_localizations.)`,
          ],
    ),
  };
}

function checkTexts(localizations: LocalizationInput[]): void {
  const locales = localizations.map(({ locale }) => locale);
  const repeated = [
    ...new Set(locales.filter((locale, index) => locales.indexOf(locale) !== index)),
  ];
  const problems = repeated.map(
    (locale) => `Locale ${locale} appears more than once. Merge the entries into one`,
  );
  for (const entry of localizations) {
    for (const name of FIELD_NAMES) {
      const value = entry[name];
      if (value === undefined || value === null || value === '') {
        continue;
      }
      const { label, limit, url } = rule(name);
      const length = [...value].length;
      if (limit !== undefined && length > limit) {
        problems.push(`${label} for ${entry.locale}: ${length} characters (limit: ${limit})`);
      }
      if (url === true && !isWebUrl(value)) {
        problems.push(`${label} for ${entry.locale}: not an http or https URL`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The check before writing found problems. Nothing was changed.\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  }
}

async function readSnapshot(
  client: AscClient,
  appleId: string,
  versionId: string,
  withAppInfo: boolean,
): Promise<Snapshot> {
  const [versionLocalizations, appInfoLocalizations] = await Promise.all([
    readVersionLocalizations(client, versionId),
    withAppInfo ? editableAppInfoLocalizations(client, appleId) : [],
  ]);
  return {
    appStoreVersionLocalizations: versionLocalizations.map(
      ({ id, attributes: { locale, ...values } }) => ({ id, locale, values }),
    ),
    appInfoLocalizations: appInfoLocalizations.map(({ id, attributes: { locale, ...values } }) => ({
      id,
      locale,
      values,
    })),
  };
}

async function editableAppInfoLocalizations(client: AscClient, appleId: string) {
  const editable = await findEditableAppInfo(
    client,
    appleId,
    'name, subtitle, and privacy policy URL',
  );
  return readAppInfoLocalizations(client, editable.id);
}

function plan(wanted: Wanted[], current: Snapshot): Write[] {
  const missing: string[] = [];
  const writes: Write[] = [];
  for (const { locale, values } of wanted) {
    for (const resource of RESOURCES) {
      const fields = FIELD_NAMES.filter(
        (name) => values[name] !== undefined && rule(name).resource === resource,
      );
      if (fields.length === 0) {
        continue;
      }
      const target = current[resource].find((candidate) => candidate.locale === locale);
      if (target === undefined) {
        const known = current[resource].map((candidate) => candidate.locale).join(', ');
        missing.push(
          resource === 'appInfoLocalizations'
            ? `No App Information text exists for locale ${locale}. The App Information locales are ${known}`
            : `No version text exists for locale ${locale}. The version locales are ${known}`,
        );
        continue;
      }
      const changed = fields.filter((name) => values[name] !== target.values[name]);
      if (changed.length > 0) {
        writes.push({
          resource,
          id: target.id,
          locale,
          fields: changed,
          attributes: Object.fromEntries(changed.map((name) => [name, values[name] ?? null])),
        });
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.join('.\n')}.\nAdd locales in App Store Connect. Nothing was changed.`,
    );
  }
  return writes;
}

function valueIn(snapshot: Snapshot, write: Write, field: FieldName): string | null {
  return snapshot[write.resource].find(({ id }) => id === write.id)?.values[field] ?? null;
}

function isWebUrl(value: string): boolean {
  return URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}

function describeField({ label, limit, url, note }: FieldRule): string {
  return [
    label,
    limit === undefined ? undefined : `Up to ${limit} characters`,
    url === true ? 'An http or https URL' : undefined,
    note,
    'Pass null or an empty string to delete the value. Omit the field to keep the value',
  ]
    .filter((part) => part !== undefined)
    .join('. ')
    .concat('.');
}
