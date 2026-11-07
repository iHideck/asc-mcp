import { vi } from 'vitest';
import { specViolations, type Method } from './openapi.ts';

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function fakeFetch(...responses: Response[]) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toLowerCase() as Method;
    const violations = specViolations(method, url);
    if (violations.length > 0) {
      throw new Error(`OpenAPI の仕様と違うリクエストです。${violations.join('。')}`);
    }
    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`応答を用意していないリクエストです: ${url.pathname}${url.search}`);
    }
    return response;
  });
}
