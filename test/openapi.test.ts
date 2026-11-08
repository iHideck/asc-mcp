import { describe, expect, it } from 'vitest';
import { specAt, specViolations } from './openapi.ts';

function api(pathAndQuery: string): URL {
  return new URL(pathAndQuery, 'https://api.appstoreconnect.apple.com');
}

// 仕様のすべての形から、名前が当てはまる項目を集める
function propertyNames(pattern: RegExp): string[] {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        Object.keys(value)
          .filter((name) => pattern.test(name))
          .forEach((name) => names.add(name));
      }
      walk(value);
    }
  };
  walk(specAt('/components/schemas'));
  return [...names].sort();
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

  it('仕様どおりの本文は通す', () => {
    expect(
      specViolations('patch', api('/v1/appStoreVersions/v1'), {
        data: {
          type: 'appStoreVersions',
          id: 'v1',
          attributes: { releaseType: 'MANUAL', earliestReleaseDate: null },
        },
      }),
    ).toEqual([]);
  });

  it('本文の、仕様に無い名前と値・欠けた項目・使えない null・使わなくなった項目を挙げる', () => {
    expect(
      specViolations('post', api('/v1/appStoreVersions'), {
        data: {
          type: 'appStoreVersions',
          attributes: {
            platform: 'IOS',
            versionString: null,
            releaseTyp: 'MANUAL',
            earliestReleaseDate: 'tomorrow',
            usesIdfa: false,
          },
          relationships: { app: { data: { type: 'app' } } },
        },
      }),
    ).toEqual([
      '本文.data.attributes.versionString に null は使えません',
      '本文.data.attributes.releaseTyp は、仕様にありません',
      '本文.data.attributes.earliestReleaseDate は日時です',
      '本文.data.attributes.usesIdfa は、仕様で使わないことになっています',
      '本文.data.relationships.app.data.id が要ります',
      '本文.data.relationships.app.data.type に "app" は使えません',
    ]);
  });

  it('$ref の横に書いた nullable も読む', () => {
    expect(
      specViolations('post', api('/v1/appStoreVersionPhasedReleases'), {
        data: {
          type: 'appStoreVersionPhasedReleases',
          attributes: { phasedReleaseState: null },
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'v1' } } },
        },
      }),
    ).toEqual([]);
  });

  it('本文を受け取らない操作への本文と、本文が要る操作の欠けた本文を挙げる', () => {
    expect(specViolations('delete', api('/v1/appStoreVersions/v1'), {})).toEqual([
      'DELETE /v1/appStoreVersions/{id} は、本文を受け取りません',
    ]);
    expect(specViolations('patch', api('/v1/appStoreVersions/v1'))).toEqual([
      'PATCH /v1/appStoreVersions/{id} には、本文が要ります',
    ]);
  });
  it('仕様で deprecated の操作を使うと、違反として返す', () => {
    expect(specViolations('delete', api('/v1/appStoreVersionSubmissions/s1'))).toEqual([
      'DELETE /v1/appStoreVersionSubmissions/{id} は、仕様で deprecated です',
    ]);
  });

  it('App Store で、Apple シリコンの Mac と Apple Vision Pro に配信する項目は、まだ仕様に無い', () => {
    // 名前が増えたら、Apple が App Store での配信の項目を足したかもしれない。読み書きするツールを作る。
    // いまある 3 つは、TestFlight のグループとビルドのもので、App Store での配信ではない
    expect(propertyNames(/AppleSilicon|AppleVision|VisionPro|MacAppStore/i)).toEqual([
      'iosBuildsAvailableForAppleSiliconMac',
      'iosBuildsAvailableForAppleVision',
      'isIosBuildMacAppStoreCompatible',
    ]);
  });
});
