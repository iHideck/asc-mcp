import { describe, expect, it } from 'vitest';
import { AscApiError } from '../plugin/src/client.ts';
import { trackProgress } from '../plugin/src/progress.ts';

async function failAfterOneWrite(error: Error): Promise<string> {
  const progress = trackProgress();
  await progress.write('creating the submission', 'Created the submission', async () => 's1');
  return progress
    .write('submitting', 'Submitted', async () => {
      throw error;
    })
    .catch((thrown: unknown) => (thrown instanceof Error ? thrown.message : ''));
}

describe('trackProgress', () => {
  it('Apple が頼みを断ったときは直してから、それ以外はそのまま、やり直すよう返す', async () => {
    expect(await failAfterOneWrite(new AscApiError(409, '409 の文'))).toBe(
      'Created the submission. Stopped while submitting. Fix the problem in the error, then make the same call again to do only the rest.\n409 の文',
    );
    expect(await failAfterOneWrite(new AscApiError(500, '500 の文'))).toBe(
      'Created the submission. Stopped while submitting. Make the same call again to do only the rest.\n500 の文',
    );
    expect(await failAfterOneWrite(new AscApiError(429, '429 の文'))).toContain(
      'Stopped while submitting. Make the same call',
    );
  });

  it('最初の書き込みで失敗したら、エラーをそのまま返す', async () => {
    const error = new AscApiError(409, '409 の文');

    await expect(
      trackProgress().write('submitting', 'Submitted', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
