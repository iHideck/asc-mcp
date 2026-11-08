import { describe, expect, it } from 'vitest';
import { AscApiError } from '../plugin/src/client.ts';
import { trackProgress } from '../plugin/src/progress.ts';

async function failAfterOneWrite(error: Error): Promise<string> {
  const progress = trackProgress();
  await progress.write('提出を作る', '提出を作りました', async () => 's1');
  return progress
    .write('出す', '出しました', async () => {
      throw error;
    })
    .catch((thrown: unknown) => (thrown instanceof Error ? thrown.message : ''));
}

describe('trackProgress', () => {
  it('Apple が頼みを断ったときは直してから、それ以外はそのまま、やり直すよう返す', async () => {
    expect(await failAfterOneWrite(new AscApiError(409, '409 の文'))).toBe(
      '提出を作りました。出すところで止まりました。エラーの所を直してから、同じ呼び出しをやり直すと、残りだけを行います。\n409 の文',
    );
    expect(await failAfterOneWrite(new AscApiError(500, '500 の文'))).toBe(
      '提出を作りました。出すところで止まりました。同じ呼び出しをやり直すと、残りだけを行います。\n500 の文',
    );
    expect(await failAfterOneWrite(new AscApiError(429, '429 の文'))).toContain(
      '止まりました。同じ呼び出しを',
    );
  });

  it('最初の書き込みで失敗したら、エラーをそのまま返す', async () => {
    const error = new AscApiError(409, '409 の文');

    await expect(
      trackProgress().write('出す', '出しました', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
