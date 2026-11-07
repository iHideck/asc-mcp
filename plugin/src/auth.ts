import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type Credentials = {
  issuerId: string;
  keyId: string;
  privateKey: KeyObject;
};

export type Token = { value: string; expiresAt: number };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const SETUP_HINT =
  '/plugin configure asc-mcp@asc-mcp で Issuer ID と Key ID を入れてから、Claude Code を起動し直してください。';

const AUDIENCE = 'appstoreconnect-v1';
// Apple は、有効期限が20分より先のトークンを受け付けない
const TOKEN_LIFETIME_SECONDS = 15 * 60;
const REFRESH_BEFORE_SECONDS = 60;

export function privateKeyPath(keyId: string, home: string): string {
  return join(home, '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`);
}

export async function loadCredentials(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): Promise<Credentials> {
  const issuerId = z.guid().safeParse(env.ASC_ISSUER_ID);
  const keyId = z
    .string()
    .regex(/^[A-Z0-9]+$/)
    .safeParse(env.ASC_KEY_ID);
  if (!issuerId.success || !keyId.success) {
    const missing = [
      ...(issuerId.success ? [] : ['Issuer ID']),
      ...(keyId.success ? [] : ['Key ID']),
    ];
    throw new ConfigError(
      `${missing.join(' と ')} が、設定されていないか、形が違います。${SETUP_HINT}`,
    );
  }

  const path = privateKeyPath(keyId.data, home);
  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(
      `秘密鍵のファイル ${path} を読めません。App Store Connect からダウンロードした .p8 のファイルを、このパスに置いてください。`,
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new ConfigError(
      `${path} を秘密鍵として読めません。App Store Connect からダウンロードしたファイルかを確かめてください。`,
    );
  }
  return { issuerId: issuerId.data, keyId: keyId.data, privateKey };
}

export function signToken(credentials: Credentials, issuedAt: number): Token {
  const expiresAt = issuedAt + TOKEN_LIFETIME_SECONDS;
  const header = encode({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' });
  const payload = encode({
    iss: credentials.issuerId,
    iat: issuedAt,
    exp: expiresAt,
    aud: AUDIENCE,
  });
  // JWT の ES256 の署名は、DER でなく、r と s をつないだ64バイトにする
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: credentials.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return { value: `${header}.${payload}.${signature.toString('base64url')}`, expiresAt };
}

function encode(part: object): string {
  return Buffer.from(JSON.stringify(part)).toString('base64url');
}

export function createTokenSource(
  credentials: Credentials,
  now: () => number = () => Math.floor(Date.now() / 1000),
): () => string {
  let token: Token | undefined;
  return () => {
    const current = now();
    if (token === undefined || token.expiresAt - current < REFRESH_BEFORE_SECONDS) {
      token = signToken(credentials, current);
    }
    return token.value;
  };
}
