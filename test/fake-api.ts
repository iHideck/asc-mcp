import { vi } from 'vitest';
import { specViolations, type Method } from './openapi.ts';

const ORIGIN = 'https://api.appstoreconnect.apple.com';

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function page(
  data: unknown[],
  { included, next }: { included?: unknown[]; next?: string } = {},
): Response {
  return jsonResponse(200, {
    data,
    ...(included === undefined ? {} : { included }),
    links: {
      self: `${ORIGIN}/v1/self`,
      ...(next === undefined ? {} : { next: `${ORIGIN}${next}` }),
    },
  });
}

export function resource(
  type: string,
  id: string,
  attributes: Record<string, unknown>,
  relationships: Record<string, string | string[] | null> = {},
) {
  return {
    type,
    id,
    attributes,
    relationships: Object.fromEntries(
      Object.entries(relationships).map(([name, ids]) => [name, { data: identifiers(ids) }]),
    ),
  };
}

// 関連は「型:id」の形で書く
function identifiers(ids: string | string[] | null) {
  const identifier = (value: string) => {
    const [type = '', id = ''] = value.split(':');
    return { type, id };
  };
  if (ids === null) {
    return null;
  }
  return Array.isArray(ids) ? ids.map(identifier) : identifier(ids);
}

export function created(type: string, id: string): Response {
  return jsonResponse(201, { data: { type, id, attributes: {} } });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

// 応答は「パス」（GET）か「メソッド パス」の名前で用意する
export function fakeFetch(routes: Record<string, Response | Response[]>) {
  const queues = new Map(
    Object.entries(routes).map(([route, responses]) => [
      route.includes(' ') ? route : `GET ${route}`,
      Array.isArray(responses) ? [...responses] : [responses],
    ]),
  );
  return vi.fn<typeof fetch>(async (input, init) => {
    const { method, url, body } = request(input, init);
    const violations = specViolations(method.toLowerCase() as Method, url, body);
    if (violations.length > 0) {
      throw new Error(`OpenAPI の仕様と違うリクエストです。${violations.join('。')}`);
    }
    const route = `${method} ${url.pathname}`;
    const response = queues.get(route)?.shift();
    if (response === undefined) {
      throw new Error(`応答を用意していないリクエストです: ${route}${url.search}`);
    }
    return response;
  });
}

export function requestedUrls(fetchFn: ReturnType<typeof fakeFetch>): URL[] {
  return fetchFn.mock.calls.map(([input, init]) => request(input, init).url);
}

// GET のほかに送ったリクエスト（作る・変える・消す）を、送った順に返す
export function sentWrites(fetchFn: ReturnType<typeof fakeFetch>) {
  return fetchFn.mock.calls
    .map(([input, init]) => request(input, init))
    .filter(({ method }) => method !== 'GET')
    .map(({ method, url, body }) => ({ method, path: url.pathname, body }));
}

function request(input: string | URL | Request, init: RequestInit | undefined) {
  return {
    method: init?.method ?? 'GET',
    url: new URL(input instanceof Request ? input.url : input),
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
  };
}
