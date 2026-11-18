// 「Liquid Glass by sennin」（ガラス調のデザイン）の設定
// この端末に保存する（ダークモードや Liquid Glass アイコンと同じ扱い）。
// オンのときは <html data-liquid-senin="on"> が付き、liquid-senin.css の配色・質感が有効になる。
const KEY = "sorachat-liquid-senin";

// 今オンかどうか（既定はオフ）
export function getLiquidSenin(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

// オン・オフを保存し、すぐに画面へ反映する
export function setLiquidSenin(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // 保存できなくても、この画面の中では切り替わる
  }
  applyLiquidSenin();
}

// 保存された設定を <html> に反映する（起動時と切り替え時に呼ぶ）
export function applyLiquidSenin() {
  const root = document.documentElement;
  if (getLiquidSenin()) root.dataset.liquidSenin = "on";
  else delete root.dataset.liquidSenin;
}
