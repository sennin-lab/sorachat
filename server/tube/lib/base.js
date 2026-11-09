// SoraChat の中で /tube の下に置かれるときの接頭辞。画面の中の「/」で始まる先を、すべてこの下に付け替える
export const TUBE_BASE = "/tube";

// HTML の中で引用符に囲まれた「/」の先（"/watch?v=…" や '/api/…'）を /tube の下へ。「//」（別のサイト）は変えない
export function withBase(html) {
  return html.replace(/(["'`])\/(?!\/|tube\/)/g, `$1${TUBE_BASE}/`);
}

// 転送先（"/" や "/history"）を /tube の下へ
export function tubePath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? TUBE_BASE + url : url;
}
