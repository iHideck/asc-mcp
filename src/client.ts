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

export function createClient(token: () => string, fetchFn: typeof fetch = fetch): AscClient {
  async function get(url: URL): Promise<unknown> {
    // 次のページの URL は応答から受け取る。App Store Connect API 以外には、トークンを送らない
    if (url.origin !== ORIGIN) {
      throw new Error(`App Store Connect API 以外の URL は呼びません: ${url.origin}`);
    }
    const response = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
      const page = Page.parse(await get(next));
      items.push(...page.data.map((entry) => item.parse(entry)));
      next = page.links?.next === undefined ? undefined : new URL(page.links.next);
    }
    return items;
  }

  return { getAll };
}

function describeError(status: number, body: unknown): string {
  const parsed = ErrorBody.safeParse(body);
  const details = parsed.success
    ? parsed.data.errors.map((error) =>
        [error.code, error.title, error.detail].filter(Boolean).join(': '),
      )
    : [];
  return [`App Store Connect API が ${status} を返しました。`, HINTS[status], ...details]
    .filter((line) => line !== undefined)
    .join('\n');
}
