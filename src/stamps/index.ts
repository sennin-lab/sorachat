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

// 以前の名前（「#U3042#U308a…」のように文字コードで書かれた名前、「╧Ç├╝├ñ…」のように文字化けした名前）で送られたスタンプを、今の名前に読み替える
// サーバーと同じ変換（server/stampRef.ts と揃えておく）
// 日本語のファイル名が「UTF-8 の文字を CP437 として読み直す」変換を2回受けると「╧Ç├╝├ñ…」のような名前になる。
// 以前この名前のまま送られたスタンプも、元の日本語名に戻す（日本語など CP437 にない文字を含む名前は触らない）
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
const CP437_BYTE = new Map<string, number>();
[...CP437_HIGH].forEach((ch, i) => CP437_BYTE.set(ch, 0x80 + i));
CP437_BYTE.set("\u03bc", 0xe6);

function undoMojibake(text: string): string {
  let current = text;
  for (let round = 0; round < 3; round++) {
    if (/^[\x00-\x7f]*$/.test(current)) break;
    const bytes: number[] = [];
    for (const ch of current) {
      const code = ch.codePointAt(0) as number;
      if (code < 0x80) {
        bytes.push(code);
        continue;
      }
      const byte = CP437_BYTE.get(ch);
      if (byte === undefined) return current;
      bytes.push(byte);
    }
    let next: string;
    try {
      next = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      return current;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

const decodeLegacyRef = (ref: string) =>
  undoMojibake(ref.replace(/#U([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));

// スタンプの指定を、サーバーと同じ名前（builtin:おめでとう.png のような形）に直す。ストアのパックの判定に使う
export const canonicalStampRef = (ref: string): string =>
  ref.startsWith("builtin:") ? decodeLegacyRef(ref) : ref;

// スタンプの指定（ref）から表示する画像のURLを求める
export const stampUrlOf = (ref: string): string | null => {
  if (ref.startsWith("builtin:")) return urlByRef.get(ref) ?? urlByRef.get(decodeLegacyRef(ref)) ?? null;
  if (ref.startsWith("user:")) return `/api/stamps/${ref.slice(5)}/image`;
  // senninstudio のスタンプ（作品の画像）
  if (ref.startsWith("studio:")) return `/api/studio/images/${ref.slice(7)}`;
  return null;
};
