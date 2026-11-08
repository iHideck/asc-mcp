import { z } from 'zod';
import { findApp, type AppSummary } from './apps.ts';
import type { AscClient, Attributes } from './client.ts';
import {
  listCurrentAppInfos,
  readAppInfoLocalizations,
  readVersionLocalizations,
} from './localizations.ts';
import { trackProgress } from './progress.ts';
import { isFirstRelease, listVersions, pickEditableVersion, type Platform } from './versions.ts';

export const EDITABLE_APP_INFO_STATES: readonly string[] = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
];

const RESOURCES = ['appStoreVersionLocalizations', 'appInfoLocalizations'] as const;
type Resource = (typeof RESOURCES)[number];

type FieldRule = { label: string; resource: Resource; limit?: number; url?: true; note?: string };

// キーワードの上限は、Apple の文書では100バイトだが、実際は文字の数で数える（日本語で191バイトのキーワードが公開されている）
const FIELDS = {
  description: { label: '概要', resource: 'appStoreVersionLocalizations', limit: 4000 },
  keywords: {
    label: 'キーワード',
    resource: 'appStoreVersionLocalizations',
    limit: 100,
    note: 'カンマで区切る',
  },
  promotionalText: {
    label: 'プロモーション用テキスト',
    resource: 'appStoreVersionLocalizations',
    limit: 170,
  },
  whatsNew: {
    label: '新機能',
    resource: 'appStoreVersionLocalizations',
    limit: 4000,
    note: '初めて出す版には無いので飛ばす',
  },
  supportUrl: { label: 'サポート URL', resource: 'appStoreVersionLocalizations', url: true },
  marketingUrl: {
    label: 'マーケティング URL',
    resource: 'appStoreVersionLocalizations',
    url: true,
  },
  name: { label: '名前', resource: 'appInfoLocalizations', limit: 30 },
  subtitle: { label: 'サブタイトル', resource: 'appInfoLocalizations', limit: 30 },
  privacyPolicyUrl: {
    label: 'プライバシーポリシーの URL',
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
  locale: z.string().min(1).describe('言語のコード（例: ja、en-US）。get_localizations で見られる'),
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
          reason: '初めて出す版には、新機能の文がありません',
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
    const what = `${locale} の${fields.map((field) => rule(field).label).join('・')}`;
    await progress.write(`${what}を変える`, `${what}を変えました`, () =>
      client.update(resource, id, attributes),
    );
  }
  const after = writes.length === 0 ? before : await progress.read('変えた文を読み直す', read);
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
            `App Store Connect の値が、頼んだものと違います: ${locale} の${rule(field).label}（Apple が直したかもしれません。get_localizations で確かめてください）`,
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
    (locale) => `言語 ${locale} が2回以上あります。1つにまとめてください`,
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
        problems.push(`${entry.locale} の${label}: ${length} 文字（${limit} 文字まで）`);
      }
      if (url === true && !isWebUrl(value)) {
        problems.push(`${entry.locale} の${label}: http か https の URL ではありません`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `入れる前に確かめたら、合わない所がありました。何も変えていません。\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
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
  const appInfos = await listCurrentAppInfos(client, appleId);
  const editable = appInfos.find(({ state }) => EDITABLE_APP_INFO_STATES.includes(state));
  if (editable === undefined) {
    throw new Error(
      `App 情報（名前・サブタイトル・プライバシーポリシーの URL）に、いま編集できるものがありません（App 情報の状態: ${appInfos.map(({ state }) => state).join('、')}）。何も変えていません。`,
    );
  }
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
        const known = current[resource].map((candidate) => candidate.locale).join('、');
        missing.push(
          resource === 'appInfoLocalizations'
            ? `言語 ${locale} の、App 情報の文はありません。App 情報の言語は ${known} です`
            : `言語 ${locale} の、版の文はありません。版の言語は ${known} です`,
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
      `${missing.join('。\n')}。\n言語を足すのは、App Store Connect の画面で行ってください。何も変えていません。`,
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
    limit === undefined ? undefined : `${limit} 文字まで`,
    url === true ? 'http か https の URL' : undefined,
    note,
    'null か空の文字にすると消す。省くと変えない',
  ]
    .filter((part) => part !== undefined)
    .join('。');
}
