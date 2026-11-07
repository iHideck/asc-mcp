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

export function fakeFetch(routes: Record<string, Response | Response[]>) {
  const queues = new Map(
    Object.entries(routes).map(([path, route]) => [path, Array.isArray(route) ? route : [route]]),
  );
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toLowerCase() as Method;
    const violations = specViolations(method, url);
    if (violations.length > 0) {
      throw new Error(`OpenAPI の仕様と違うリクエストです。${violations.join('。')}`);
    }
    const response = queues.get(url.pathname)?.shift();
    if (response === undefined) {
      throw new Error(`応答を用意していないリクエストです: ${url.pathname}${url.search}`);
    }
    return response;
  });
}

export function requestedUrls(fetchFn: ReturnType<typeof fakeFetch>): URL[] {
  return fetchFn.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input));
}
