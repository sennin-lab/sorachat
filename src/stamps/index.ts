/// <reference types="vite/client" />
// 組み込みスタンプ。このフォルダに画像（png・webp・gif・jpg・svg）を置くと、自動で一覧に出ます。
// ファイル名がそのままスタンプの名前になります（英数字・ハイフン・アンダースコア推奨）。
const files = import.meta.glob("./*.{png,webp,gif,jpg,jpeg,svg}", {
  eager: true,
  query: "?url",
  import: "default"
}) as Record<string, string>;

export type Stamp = { ref: string; name: string; url: string };

export const BUILTIN_STAMPS: Stamp[] = Object.entries(files)
  .map(([path, url]) => {
    const file = path.replace(/^\.\//, "");
    return { ref: `builtin:${file}`, name: file.replace(/\.[^.]+$/, ""), url };
  })
  .sort((a, b) => a.name.localeCompare(b.name, "ja"));

const urlByRef = new Map(BUILTIN_STAMPS.map((s) => [s.ref, s.url]));

// スタンプの指定（ref）から表示する画像のURLを求める
export const stampUrlOf = (ref: string): string | null => {
  if (ref.startsWith("builtin:")) return urlByRef.get(ref) ?? null;
  if (ref.startsWith("user:")) return `/api/stamps/${ref.slice(5)}/image`;
  return null;
};
