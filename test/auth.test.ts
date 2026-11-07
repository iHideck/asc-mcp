import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  createTokenSource,
  loadCredentials,
  privateKeyPath,
  signToken,
} from '../plugin/src/auth.ts';

const ISSUER_ID = '57246542-96fe-1a63-e053-0824d011072a';
const KEY_ID = '2X9R4HXF34';
const ENV = { ASC_ISSUER_ID: ISSUER_ID, ASC_KEY_ID: KEY_ID };

async function emptyHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'asc-mcp-'));
}

async function homeWithKey(): Promise<{ home: string; publicKey: KeyObject }> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const home = await emptyHome();
  const path = privateKeyPath(KEY_ID, home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { home, publicKey };
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString());
}

describe('loadCredentials と signToken', () => {
  it('秘密鍵で、App Store Connect API が受け付ける形の JWT に署名する', async () => {
    const { home, publicKey } = await homeWithKey();
    const credentials = await loadCredentials(ENV, home);

    const [header = '', payload = '', signature = ''] = signToken(
      credentials,
      1_700_000_000,
    ).value.split('.');

    expect(decode(header)).toEqual({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
    expect(decode(payload)).toEqual({
      iss: ISSUER_ID,
      iat: 1_700_000_000,
      exp: 1_700_000_900,
      aud: 'appstoreconnect-v1',
    });
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    expect(valid).toBe(true);
  });

  it.each([
    ['無い', {}],
    ['空', { ASC_ISSUER_ID: '', ASC_KEY_ID: '' }],
    [
      '置き換えられていない',
      { ASC_ISSUER_ID: '${user_config.issuer_id}', ASC_KEY_ID: '${user_config.key_id}' },
    ],
  ])('Issuer ID と Key ID が%sときは、設定の直し方を返す', async (_, env) => {
    const result = loadCredentials(env, await emptyHome());

    await expect(result).rejects.toThrow(ConfigError);
    await expect(result).rejects.toThrow(/Issuer ID と Key ID.*\/plugin configure asc-mcp@asc-mcp/);
  });

  it('秘密鍵のファイルが無いときは、置く場所を返す', async () => {
    const home = await emptyHome();

    await expect(loadCredentials(ENV, home)).rejects.toThrow(privateKeyPath(KEY_ID, home));
  });

  it('秘密鍵として読めないファイルは、受け付けない', async () => {
    const home = await emptyHome();
    const path = privateKeyPath(KEY_ID, home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not a key');

    await expect(loadCredentials(ENV, home)).rejects.toThrow(ConfigError);
  });
});

describe('createTokenSource', () => {
  it('有効期限の1分前までは同じトークンを返し、そのあとは作り直す', async () => {
    const { home } = await homeWithKey();
    let now = 1_700_000_000;
    const token = createTokenSource(await loadCredentials(ENV, home), () => now);
    const first = token();

    now += 15 * 60 - 61;
    expect(token()).toBe(first);

    now += 2;
    expect(token()).not.toBe(first);
  });
});
