import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { listApps } from './apps.ts';
import { createTokenSource, loadCredentials } from './auth.ts';
import { createClient, isReadOnly, type AscClient } from './client.ts';
import { ensureVersion, RELEASE_TYPES } from './ensure-version.ts';
import { getLocalizations } from './localizations.ts';
import { getReleaseStatus } from './release-status.ts';
import { PHASED_RELEASE_ACTIONS, releaseVersion, setPhasedRelease } from './release.ts';
import { setReviewDetail } from './review-detail.ts';
import { cancelReview, submitForReview } from './review-submission.ts';
import { selectBuild } from './select-build.ts';
import { localizationInput, setLocalizations } from './set-localizations.ts';
import { PLATFORMS } from './versions.ts';

let client: AscClient | undefined;

// 鍵は、ツールが初めて呼ばれたときに読む。鍵のファイルを置く前でもサーバーは起動し、ツールが置き場所を返す
async function getClient(): Promise<AscClient> {
  client ??= createClient(
    createTokenSource(await loadCredentials(process.env)),
    fetch,
    isReadOnly(process.env.ASC_READ_ONLY),
  );
  return client;
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const appArguments = {
  bundleId: z.string().min(1).describe('アプリのバンドル ID（例: com.ihideck.machosterone）'),
  platform: z.enum(PLATFORMS).default('IOS'),
};

// 外に出る操作は、Claude Code が呼ぶたびに、利用者の確認を求める（どの権限のモードでも、許可の決まりでも省けない）
const NEEDS_APPROVAL = { 'anthropic/requiresUserInteraction': true };

const server = new McpServer({ name: 'asc-mcp', version: packageJson.version });

server.registerTool(
  'list_apps',
  {
    title: 'アプリの一覧',
    description: 'App Store Connect にあるアプリの、名前・バンドル ID・Apple ID を返す。',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => json({ apps: await listApps(await getClient()) }),
);

server.registerTool(
  'get_release_status',
  {
    title: 'リリースの状態',
    description:
      '新しい順に5つのビルドと、公開中の版と次に出す版を返す。ビルドは、処理の状態・TestFlight の状態・配ったグループ・アップロードのときの ITMS- のエラーと警告（uploadIssues。記録が無ければ null）。版は、状態・公開のしかた・選んだビルド・段階的リリース。',
    inputSchema: z.object(appArguments),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ bundleId, platform }) =>
    json(await getReleaseStatus(await getClient(), bundleId, platform)),
);

server.registerTool(
  'get_localizations',
  {
    title: '掲載の文',
    description:
      '版の言語ごとの文（概要・キーワード・プロモーション用テキスト・新機能・サポート URL・マーケティング URL）と、App 情報の言語ごとの文（名前・サブタイトル・プライバシーポリシーの URL）を返す。App 情報は版に結び付かず、公開中のものと、次の版のために編集中のものがあるので、状態を付けて返す。言語が多くて出力が大きいときは、locales で絞る。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          '読む版（例: 1.0.1）。省くと、いちばん新しい版（次に出す版があればそれ、なければ公開中の版）を読む',
        ),
      locales: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('読む言語（例: ["ja", "en-US"]）。省くと、すべての言語を読む'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (request) => json(await getLocalizations(await getClient(), request)),
);

server.registerTool(
  'ensure_version',
  {
    title: '版を用意する',
    description:
      '次に出す版を用意する。その番号の版が無ければ作る。編集できる版（提出の準備中・却下のあと）が別の番号なら、その版の番号を変える。公開のしかたと段階的リリースは、渡したものだけをそろえる。審査中の版は変えず、公開したことのある番号は使わない。変える前と後の版と、気を付けること（warnings）を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .describe(
          '版の番号（例: 1.0.2）。上げるビルドの版（CFBundleShortVersionString）と同じにする',
        ),
      releaseType: z
        .enum(RELEASE_TYPES)
        .optional()
        .describe(
          '公開のしかた。MANUAL は審査のあと手動で、AFTER_APPROVAL は審査が通ったらすぐ、SCHEDULED は earliestReleaseDate の日時から公開する。省くと変えない',
        ),
      earliestReleaseDate: z.iso
        .datetime({ offset: true })
        .optional()
        .describe(
          'SCHEDULED のときの、公開する日時。正時で、いまより先にする（例: 2026-12-01T10:00:00+09:00）',
        ),
      phasedRelease: z
        .boolean()
        .optional()
        .describe(
          '段階的リリース（7日かけて、自動で更新する利用者に少しずつ出す）を使うか。省くと変えない',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await ensureVersion(await getClient(), request)),
);

server.registerTool(
  'select_build',
  {
    title: 'ビルドを選ぶ',
    description:
      '版に、審査に出すビルドを選ぶ。選べるのは、処理が済み（VALID）、期限が切れておらず、ビルドの版（CFBundleShortVersionString）が版の番号と同じビルド。版は、編集できるもの（提出の準備中・却下のあと）だけ。選ぶ前と後のビルドと、気を付けること（warnings）を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe('ビルドを選ぶ版（例: 1.0.2）。省くと、編集できる版に選ぶ'),
      buildNumber: z.string().min(1).describe('ビルドの番号（CFBundleVersion。例: 12）'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await selectBuild(await getClient(), request)),
);

server.registerTool(
  'set_localizations',
  {
    title: '掲載の文を入れる',
    description:
      '編集できる版（提出の準備中・却下のあと）に、言語ごとの掲載の文を入れる。版の文（概要・キーワード・プロモーション用テキスト・新機能・URL）と、App 情報の文（名前・サブタイトル・プライバシーポリシーの URL）のうち、渡した項目だけを変える。入れる前に上限の文字数と URL の形を確かめ、1つでも合わなければ何も変えない。初めて出す版では、新機能の文を飛ばす。言語は足さない。変えた項目の前と後と、気を付けること（warnings）を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe('文を入れる版（例: 1.0.2）。省くと、編集できる版に入れる'),
      localizations: z
        .array(localizationInput)
        .min(1)
        .describe('言語ごとの文。渡さない項目は変えない'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setLocalizations(await getClient(), request)),
);

server.registerTool(
  'set_review_detail',
  {
    title: '審査の情報を入れる',
    description:
      '編集できる版（提出の準備中・却下のあと）の、審査の情報（App Review Information）のうち、審査メモと、サインインが要るかを入れる。渡した項目だけを変える。連絡先と審査用のアカウントは入れず、欠けていれば warnings で知らせる。審査用のアカウントのパスワードは、読みも書きもしない。変える前と後を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe('審査の情報を入れる版（例: 1.0.2）。省くと、編集できる版に入れる'),
      notes: z
        .string()
        .nullable()
        .optional()
        .describe(
          '審査メモ。Apple の文書では 4000 バイトまで。null か空の文字にすると消す。省くと変えない',
        ),
      demoAccountRequired: z
        .boolean()
        .optional()
        .describe(
          'アプリを使うのに、サインインが要るか。要るときは、審査用のアカウントを App Store Connect の画面で入れる。省くと変えない',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setReviewDetail(await getClient(), request)),
);

server.registerTool(
  'submit_for_review',
  {
    title: '審査に出す',
    description:
      '版を審査に出す。出す前に、ビルドが選んであり、そのビルドの版が版の番号と同じで、処理が済み、輸出コンプライアンスの答えがあることを確かめる。作りかけの提出があれば、それを使う。もう審査に出してある版は、そのまま返す。呼ぶたびに、利用者の確認が要る。出す前と後の状態を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe('審査に出す版（例: 1.0.2）。省くと、編集できる版を出す'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await submitForReview(await getClient(), request)),
);

server.registerTool(
  'cancel_review',
  {
    title: '審査を取り下げる',
    description:
      '審査待ち・審査中の版を、審査から取り下げる。取り下げた版は、編集できるようになる。審査に出していない版は、そのまま返す。呼ぶたびに、利用者の確認が要る。取り下げる前と後の状態を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe('取り下げる版（例: 1.0.2）。省くと、審査に出している版を取り下げる'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await cancelReview(await getClient(), request)),
);

server.registerTool(
  'release_version',
  {
    title: '版を公開する',
    description:
      '審査が通り、手動の公開を待っている版（PENDING_DEVELOPER_RELEASE）を、App Store に公開する。公開は取り消せない。公開済みの版は、そのまま返す。段階的リリースを付けた版は、公開すると段階的リリースが始まる。呼ぶたびに、利用者の確認が要る。公開する前と後の版を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe('公開する版（例: 1.0.2）。省くと、公開を待っている版を公開する'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await releaseVersion(await getClient(), request)),
);

server.registerTool(
  'set_phased_release',
  {
    title: '段階的リリースを変える',
    description:
      '進めている段階的リリースを、止める（pause）・再開する（resume）・全員に出す（complete）。全員に出すのは取り消せない。もうその状態なら、そのまま返す。まだ始まっていない・もう終わった段階的リリースは変えない。呼ぶたびに、利用者の確認が要る。変える前と後の版を返す。',
    inputSchema: z.object({
      ...appArguments,
      versionString: z
        .string()
        .min(1)
        .optional()
        .describe(
          '段階的リリースを変える版（例: 1.0.2）。省くと、段階的リリースを進めている版を変える',
        ),
      action: z
        .enum(PHASED_RELEASE_ACTIONS)
        .describe(
          'pause は止める、resume は再開する、complete は残りの利用者にも、すぐに全員に出す',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await setPhasedRelease(await getClient(), request)),
);

await server.connect(new StdioServerTransport());
