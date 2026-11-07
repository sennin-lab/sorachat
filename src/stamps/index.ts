/// <reference types="vite/client" />
// 組み込みスタンプ。このフォルダに画像（png・webp・gif・jpg・svg）を置くと、自動で一覧に出ます。
// ファイル名がそのままスタンプの名前になります（英数字・ハイフン・アンダースコア推奨）。
import { canonicalStampRef, decodeStampName, stampNameOf } from "./ref";

export { canonicalStampRef, stampNameOf };

const files = import.meta.glob("./*.{png,webp,gif,jpg,jpeg,svg}", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

export type Stamp = { ref: string; name: string; url: string };

// ファイル名に「#」（#U3042… の形）が入っていると、URL の「#」以降は読まれず、画像が見つからなくなる。
// そのため、画像のURLの「#」は「%23」にして使う（「?」も同様）
const safeUrl = (url: string) => url.replace(/#/g, "%23").replace(/\?/g, "%3F");

// 名前は日本語に戻して表示する（#U… のままだと、画像が出ないときに文字として見えてしまうため）
export const BUILTIN_STAMPS: Stamp[] = Object.entries(files)
  .map(([path, url]) => {
    const file = path.replace(/^\.\//, "");
    return { ref: `builtin:${file}`, name: decodeStampName(file.replace(/\.[^.]+$/, "")), url: safeUrl(url) };
  })
  .sort((a, b) => a.name.localeCompare(b.name, "ja"));

// 画像の探し方は、送られてきた形（生の名前・日本語・文字化け）によらず、同じ正規の名前で行う
const urlByRef = new Map(BUILTIN_STAMPS.map((s) => [canonicalStampRef(s.ref), s.url]));

// スタンプの指定（ref）から表示する画像のURLを求める
export const stampUrlOf = (ref: string): string | null => {
  if (ref.startsWith("user:")) return `/api/stamps/${ref.slice(5)}/image`;
  // senninstudio のスタンプ（作品の画像）
  if (ref.startsWith("studio:")) return `/api/studio/images/${ref.slice(7)}`;
  return urlByRef.get(canonicalStampRef(ref)) ?? null;
};
