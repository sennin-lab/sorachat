// 自分の画面から削除したメッセージの記録（この端末で、再読み込みのあとも出さないため）。
// 正本はサーバー（sc_message_hides）。ここは、キャッシュや先に届いた知らせから戻ってこないようにするためだけ。
const KEY = "sorachat-hidden-messages";
const LIMIT = 2000;

export function hiddenMessageIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}

export function rememberHiddenMessage(id: string): void {
  const ids = [...hiddenMessageIds()].filter((x) => x !== id);
  ids.push(id);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids.slice(-LIMIT)));
  } catch {
    // 保存できなくても、サーバーの記録で次の読み込みから出ない
  }
}
