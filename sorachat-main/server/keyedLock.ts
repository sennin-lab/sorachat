// キーごとに処理を1つずつ順番に実行する、簡単なロック（同じキーの処理だけが待つ）。
// ・同じ2人のDMを同時に作ろうとする連打などで、重複して作られないようにする。
// ・アプリサーバーが1台の前提で動く（複数台では効かない）。
const tails = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
