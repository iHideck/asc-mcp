import { AscApiError } from './client.ts';

export type Progress = {
  write<T>(doing: string, done: string, work: () => Promise<T>): Promise<T>;
  read<T>(doing: string, work: () => Promise<T>): Promise<T>;
};

// 書くツールは、いまの状態を読んでから差だけを変えるので、やり直すと残りだけを行う
export function trackProgress(): Progress {
  const finished: string[] = [];
  async function attempt<T>(doing: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (finished.length === 0) {
        throw error;
      }
      const retry = isRequestProblem(error)
        ? 'エラーの所を直してから、同じ呼び出しをやり直すと、残りだけを行います'
        : '同じ呼び出しをやり直すと、残りだけを行います';
      throw new Error(
        `${finished.join('。')}。${doing}ところで止まりました。${retry}。\n${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return {
    async write(doing, done, work) {
      const result = await attempt(doing, work);
      finished.push(done);
      return result;
    },
    read: attempt,
  };
}

// 4xx は、頼んだ中身か、App Store Connect の状態に足りない所がある。429（呼び出しの上限）は、待てば通る
function isRequestProblem(error: unknown): boolean {
  return (
    error instanceof AscApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}
