import { z } from 'zod';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
const TIMEOUT_MS = 30_000;

export class AscApiError extends Error {
  override name = 'AscApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type AscClient = {
  getAll<T>(path: string, params: Record<string, string>, item: z.ZodType<T>): Promise<T[]>;
};

const Page = z.object({
  data: z.array(z.unknown()),
  links: z.object({ next: z.string().optional() }).optional(),
});

const ErrorBody = z.object({
  errors: z.array(
    z.object({
      code: z.string().optional(),
      title: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

const HINTS: Partial<Record<number, string>> = {
  401: 'Issuer ID・Key ID・秘密鍵が、同じ API キーのものかを確かめてください。キーを無効にしていないかも確かめてください。',
  403: 'API キーのロールでは、この操作ができません。',
  429: 'API キーごとの、1時間あたりの呼び出しの上限に達しました。しばらく待ってから、やり直してください。',
};

// Apple は、新しい契約に同意するまで、このコードの 403 を返す。ロールの不足とは直し方が違う
const AGREEMENT_HINT =
  'Account Holder が App Store Connect か Apple Developer のサイトにサインインし、新しい契約に同意してください。API キーを作り直しても直りません。';

export function createClient(token: () => string, fetchFn: typeof fetch = fetch): AscClient {
  async function get(url: URL): Promise<unknown> {
    // 次のページの URL は応答から受け取る。App Store Connect API 以外には、トークンを送らない
    if (url.origin !== ORIGIN) {
      throw new Error(`App Store Connect API 以外の URL は呼びません: ${url.origin}`);
    }
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { Authorization: `Bearer ${token()}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`App Store Connect API に接続できませんでした（${reasonOf(error)}）。`, {
        cause: error,
      });
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new AscApiError(response.status, describeError(response.status, body));
    }
    return body;
  }

  async function getAll<T>(
    path: string,
    params: Record<string, string>,
    item: z.ZodType<T>,
  ): Promise<T[]> {
    const items: T[] = [];
    let next: URL | undefined = new URL(path, ORIGIN);
    for (const [name, value] of Object.entries(params)) {
      next.searchParams.set(name, value);
    }
    while (next !== undefined) {
      const page: z.infer<typeof Page> = parse(Page, await get(next), path);
      items.push(...page.data.map((entry) => parse(item, entry, path)));
      next = page.links?.next === undefined ? undefined : new URL(page.links.next);
    }
    return items;
  }

  return { getAll };
}

function parse<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `App Store Connect API の ${path} の応答が、思っていた形と違います。\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === 'TimeoutError') {
    return `${TIMEOUT_MS / 1000}秒たっても応答がありません`;
  }
  // fetch は、DNS や TLS の失敗を cause に入れ、message は「fetch failed」だけにする
  return error.cause instanceof Error ? error.cause.message : error.message;
}

function describeError(status: number, body: unknown): string {
  const errors = ErrorBody.safeParse(body).data?.errors ?? [];
  const hint = errors.some((error) => error.code?.includes('REQUIRED_AGREEMENTS'))
    ? AGREEMENT_HINT
    : HINTS[status];
  const details = errors.map((error) =>
    [error.code, error.title, error.detail].filter(Boolean).join(': '),
  );
  return [`App Store Connect API が ${status} を返しました。`, hint, ...details]
    .filter((line) => line !== undefined)
    .join('\n');
}
