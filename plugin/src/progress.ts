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
      throw new Error(
        `${finished.join('。')}。${doing}ところで止まりました。同じ呼び出しをやり直すと、残りだけを行います。\n${error instanceof Error ? error.message : String(error)}`,
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
