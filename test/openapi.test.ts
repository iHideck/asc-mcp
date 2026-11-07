import { describe, expect, it } from 'vitest';
import { specViolations } from './openapi.ts';

function api(pathAndQuery: string): URL {
  return new URL(pathAndQuery, 'https://api.appstoreconnect.apple.com');
}

describe('specViolations', () => {
  it('仕様どおりのリクエストと、次のページの cursor は通す', () => {
    expect(
      specViolations('get', api('/v1/apps?fields[apps]=name,bundleId&sort=name&limit=200')),
    ).toEqual([]);
    expect(specViolations('get', api('/v1/apps/123/appStoreVersions?cursor=AQ'))).toEqual([]);
  });

  it('仕様に無いパスと操作を挙げる', () => {
    expect(specViolations('get', api('/v1/appz'))).toEqual(['/v1/appz は、仕様に無いパスです']);
    expect(specViolations('delete', api('/v1/apps'))).toEqual([
      'DELETE /v1/apps は、仕様に無い操作です',
    ]);
  });

  it('仕様に無い引数と値、上限を超えた数を挙げる', () => {
    expect(
      specViolations('get', api('/v1/apps?filter[nmae]=x&fields[apps]=name,nmae&limit=201')),
    ).toEqual([
      '/v1/apps に、引数 filter[nmae] はありません',
      '引数 fields[apps] に nmae は使えません',
      '引数 limit は 200 までです',
    ]);
  });
});
