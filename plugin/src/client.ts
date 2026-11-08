import { z } from 'zod';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
const TIMEOUT_MS = 30_000;
// 写真のファイルは API の本文より大きい。回線が遅くても送り終えられるだけ待つ
const UPLOAD_TIMEOUT_MS = 120_000;

export class AscApiError extends Error {
  override name = 'AscApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Params = Record<string, string>;
type Fetched<D, I> = { data: D[]; included: I[] };
type Schemas<D, I> = { data: z.ZodType<D>; included?: z.ZodType<I> };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type Attributes = Record<string, string | number | boolean | null>;

export type UploadOperation = {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders: { name: string; value: string }[];
};

export type AscClient = {
  getPage<D, I = never>(
    path: string,
    params: Params,
    schemas: Schemas<D, I>,
  ): Promise<Fetched<D, I>>;
  getAll<D, I = never>(
    path: string,
    params: Params,
    schemas: Schemas<D, I>,
  ): Promise<Fetched<D, I>>;
  getOne<D>(path: string, params: Params, schema: z.ZodType<D>): Promise<D | null>;
  create(
    type: string,
    attributes: Attributes,
    relationships: Record<string, Identifier | Identifier[]>,
    included?: object[],
  ): Promise<string>;
  createResource<D>(
    type: string,
    attributes: Attributes,
    relationships: Record<string, Identifier | Identifier[]>,
    schema: z.ZodType<D>,
  ): Promise<D>;
  update(
    type: string,
    id: string,
    attributes: Attributes,
    relationships?: Record<string, Identifier>,
  ): Promise<void>;
  setRelationship(
    type: string,
    id: string,
    name: string,
    target: Identifier | Identifier[],
  ): Promise<void>;
  remove(type: string, id: string): Promise<void>;
  upload(operation: UploadOperation, file: Uint8Array<ArrayBuffer>): Promise<void>;
};

const Page = z.object({
  data: z.array(z.unknown()),
  included: z.array(z.unknown()).optional(),
  links: z.object({ next: z.string().optional() }).optional(),
});

const Identifier = z.object({ type: z.string(), id: z.string() });
type Identifier = z.infer<typeof Identifier>;
export const toOne = z.object({ data: Identifier.nullish() }).optional();
export const toMany = z.object({ data: z.array(Identifier).optional() }).optional();

type ResourceSchema = {
  shape: {
    type: { value: string };
    attributes: { shape: object };
    relationships?: { shape: object };
  };
};

// include と fields[...] は、読む zod の形から作る。Apple は、fields[...] に無い属性と関連を返さない
export function sparseFields(primary: ResourceSchema, ...included: ResourceSchema[]): Params {
  const relationships = Object.keys(primary.shape.relationships?.shape ?? {});
  const fields = [primary, ...included].map(({ shape }) => [
    `fields[${shape.type.value}]`,
    [...Object.keys(shape.attributes.shape), ...Object.keys(shape.relationships?.shape ?? {})].join(
      ',',
    ),
  ]);
  return {
    ...(relationships.length > 0 ? { include: relationships.join(',') } : {}),
    ...Object.fromEntries(fields),
  };
}

export function findIncluded<I extends { type: string; id: string }, T extends I['type']>(
  included: readonly I[],
  type: T,
  identifier: { id: string } | null | undefined,
): Extract<I, { type: T }> | undefined {
  return included.find(
    (resource): resource is Extract<I, { type: T }> =>
      resource.type === type && resource.id === identifier?.id,
  );
}

const ErrorDetail = z.object({
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  source: z.object({ pointer: z.string().optional(), parameter: z.string().optional() }).optional(),
});

const ErrorBody = z.object({
  errors: z.array(ErrorDetail.extend({ meta: z.unknown().optional() })),
});

// 審査に出すときのエラーは、どの項目が足りないかを meta.associatedErrors に入れる
const AssociatedErrors = z.object({
  associatedErrors: z.record(z.string(), z.array(ErrorDetail)),
});

const HINTS: Partial<Record<number, string>> = {
  401: 'Issuer ID・Key ID・秘密鍵が、同じ API キーのものかを確かめてください。キーを無効にしていないかも確かめてください。',
  403: 'API キーのロールでは、この操作ができません。',
  429: 'API キーごとの、1時間あたりの呼び出しの上限に達しました。しばらく待ってから、やり直してください。',
};

// 書くツールは、いまの状態を読んでから差だけを変えるので、やり直しても二重には変えない
const RETRY_HINT = '同じ呼び出しをやり直すと、いまの状態に合わせて続きを行います。';
const WRITE_UNKNOWN_HINT = `変更が App Store Connect に届いたかは分かりません。${RETRY_HINT}`;

// Apple は、新しい契約に同意するまで、このコードの 403 を返す。ロールの不足とは直し方が違う
const AGREEMENT_HINT =
  'Account Holder が App Store Connect か Apple Developer のサイトにサインインし、新しい契約に同意してください。API キーを作り直しても直りません。';

// 書かない設定は、値が無いか 0 のときだけ外す。打ち間違い（true など）で、本番に書いてしまわないため
export function isReadOnly(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0';
}

export function createClient(
  token: () => string,
  fetchFn: typeof fetch = fetch,
  readOnly = false,
): AscClient {
  async function call(method: Method, url: URL, body?: object): Promise<unknown> {
    // 次のページの URL は応答から受け取る。App Store Connect API 以外には、トークンを送らない
    if (url.origin !== ORIGIN) {
      throw new Error(`App Store Connect API 以外の URL は呼びません: ${url.origin}`);
    }
    if (readOnly && method !== 'GET') {
      throw new Error(
        `書かない設定で動いているので、次のリクエストを送りませんでした: ${method} ${url.pathname}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`,
      );
    }
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `App Store Connect API に接続できませんでした（${reasonOf(error)}）。${method === 'GET' ? '' : WRITE_UNKNOWN_HINT}`,
        { cause: error },
      );
    }
    if (response.status === 204) {
      return undefined;
    }
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = describeError(response.status, parsed);
      throw new AscApiError(
        response.status,
        method !== 'GET' && response.status >= 500 ? `${message}\n${WRITE_UNKNOWN_HINT}` : message,
      );
    }
    return parsed;
  }

  async function read<D, I>(
    path: string,
    params: Params,
    schemas: Schemas<D, I>,
    allPages: boolean,
  ): Promise<Fetched<D, I>> {
    const fetched: Fetched<D, I> = { data: [], included: [] };
    let next: URL | undefined = urlOf(path, params);
    while (next !== undefined) {
      const page: z.infer<typeof Page> = parse(Page, await call('GET', next), path);
      fetched.data.push(...parse(z.array(schemas.data), page.data, path));
      if (schemas.included !== undefined) {
        fetched.included.push(...parse(z.array(schemas.included), page.included ?? [], path));
      }
      // Apple は、データの無いページのあとも、links.next を返し続けることがある
      next =
        allPages && page.data.length > 0 && page.links?.next !== undefined
          ? new URL(page.links.next)
          : undefined;
    }
    return fetched;
  }

  async function post<D>(
    type: string,
    attributes: Attributes,
    relationships: Record<string, Identifier | Identifier[]>,
    schema: z.ZodType<D>,
    included?: object[],
  ): Promise<D> {
    // 配信する国（appAvailabilities）は、v2 の API にしか無い
    const path = `/${type === 'appAvailabilities' ? 'v2' : 'v1'}/${type}`;
    const body = {
      data: { type, ...resourceBody(attributes, relationships) },
      ...(included === undefined ? {} : { included }),
    };
    const created = z
      .object({ data: schema })
      .safeParse(await call('POST', new URL(path, ORIGIN), body));
    if (!created.success) {
      throw new Error(
        `App Store Connect API の ${path} の応答から、作ったものを読めませんでした。${WRITE_UNKNOWN_HINT}`,
      );
    }
    return created.data.data;
  }

  return {
    getPage: (path, params, schemas) => read(path, params, schemas, false),
    getAll: (path, params, schemas) => read(path, params, schemas, true),
    async getOne(path, params, schema) {
      return parse(
        z.object({ data: schema.nullable() }),
        await call('GET', urlOf(path, params)),
        path,
      ).data;
    },
    async create(type, attributes, relationships, included) {
      return (await post(type, attributes, relationships, Identifier, included)).id;
    },
    createResource: (type, attributes, relationships, schema) =>
      post(type, attributes, relationships, schema),
    async update(type, id, attributes, relationships = {}) {
      await call('PATCH', new URL(`/v1/${type}/${id}`, ORIGIN), {
        data: { type, id, ...resourceBody(attributes, relationships) },
      });
    },
    async setRelationship(type, id, name, target) {
      await call('PATCH', new URL(`/v1/${type}/${id}/relationships/${name}`, ORIGIN), {
        data: target,
      });
    },
    async remove(type, id) {
      await call('DELETE', new URL(`/v1/${type}/${id}`, ORIGIN));
    },
    // 送り先は Apple が応答で渡す、API の外の URL。API のトークンは送らない
    async upload({ method, url, offset, length, requestHeaders }, file) {
      const target = new URL(url);
      const where = `${method} ${target.origin}${target.pathname}`;
      if (readOnly) {
        throw new Error(
          `書かない設定で動いているので、次のリクエストを送りませんでした: ${where}（${length} バイト）`,
        );
      }
      let response: Response;
      try {
        response = await fetchFn(target, {
          method,
          headers: Object.fromEntries(requestHeaders.map(({ name, value }) => [name, value])),
          body: file.subarray(offset, offset + length),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(
          `${where} に接続できませんでした（${reasonOf(error, UPLOAD_TIMEOUT_MS)}）。${RETRY_HINT}`,
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new Error(`${where} が ${response.status} を返しました。${RETRY_HINT}`);
      }
    },
  };
}

// 仕様に attributes や relationships が無い本文（審査への提出の中身・App 情報の更新など）があるので、空なら送らない
function resourceBody(
  attributes: Attributes,
  relationships: Record<string, Identifier | Identifier[]>,
) {
  return {
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
    ...(Object.keys(relationships).length === 0
      ? {}
      : {
          relationships: Object.fromEntries(
            Object.entries(relationships).map(([name, target]) => [name, { data: target }]),
          ),
        }),
  };
}

// 作る前の価格や配信する国を読むと、Apple は 404 を返す
export async function nullIfMissing<T>(read: Promise<T | null>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function describeDetail(error: z.infer<typeof ErrorDetail>): string {
  const where = error.source?.pointer ?? error.source?.parameter;
  const text = [error.code, error.title, error.detail].filter(Boolean).join(': ');
  return where === undefined ? text : `${text}（${where}）`;
}

function urlOf(path: string, params: Params): URL {
  const url = new URL(path, ORIGIN);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url;
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

function reasonOf(error: unknown, timeoutMs = TIMEOUT_MS): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === 'TimeoutError') {
    return `${timeoutMs / 1000}秒たっても応答がありません`;
  }
  // fetch は、DNS や TLS の失敗を cause に入れ、message は「fetch failed」だけにする
  return error.cause instanceof Error ? error.cause.message : error.message;
}

function describeError(status: number, body: unknown): string {
  const errors = ErrorBody.safeParse(body).data?.errors ?? [];
  const hint = errors.some((error) => error.code?.includes('REQUIRED_AGREEMENTS'))
    ? AGREEMENT_HINT
    : HINTS[status];
  const details = errors.flatMap((error) => [
    describeDetail(error),
    ...Object.entries(AssociatedErrors.safeParse(error.meta).data?.associatedErrors ?? {}).flatMap(
      ([path, associated]) => associated.map((item) => `- ${path}: ${describeDetail(item)}`),
    ),
  ]);
  return [`App Store Connect API が ${status} を返しました。`, hint, ...details]
    .filter((line) => line !== undefined)
    .join('\n');
}
