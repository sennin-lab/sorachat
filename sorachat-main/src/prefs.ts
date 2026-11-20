// 表示の設定（この端末に保存する。ダークモードと同じ扱い）
const SHOW_UNSENT_KEY = "sorachat-show-unsent";
export const PREFS_EVENT = "sorachat-prefs";

// 「送信を取り消しました」を表示するか（既定は表示する）
export function getShowUnsent(): boolean {
  try {
    return localStorage.getItem(SHOW_UNSENT_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setShowUnsent(on: boolean) {
  try {
    localStorage.setItem(SHOW_UNSENT_KEY, on ? "on" : "off");
  } catch {
    // 保存できなくても、この画面の中では切り替わる
  }
  window.dispatchEvent(new Event(PREFS_EVENT));
}
