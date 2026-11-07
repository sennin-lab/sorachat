// スタンプの指定（ref）と名前の読み替え。画面（クライアント）とサーバー（server/stampRef.ts）は同じ結果になること。
// 送った・保存されたスタンプは、次の形のどれかで残っている（古いものほど前のほうの形）。
//   1. 「builtin:#U3042#U308a….png」… ファイル名を文字コードで書いたもの（ファイルそのままの名前）
//   2. 「builtin:ありがとう.png」…… 日本語に戻したもの（サーバーが保存・返すときの形）
//   3. 「builtin:╧Ç├╝├ñ….png」…… UTF-8 を CP437 として読み直して文字化けしたもの（古い送信）
//   4. 「#U3042#U308a….png」…… 「builtin:」が付いていないもの
// どれも「ありがとう.png」に読み替えてから、画像を探す。

const LEGACY_CODE = /#U([0-9a-fA-F]{4})/g;

const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
const CP437_BYTE = new Map<string, number>();
[...CP437_HIGH].forEach((ch, i) => CP437_BYTE.set(ch, 0x80 + i));
CP437_BYTE.set("\u03bc", 0xe6);

// 文字化け（UTF-8 を CP437 として読んだもの）を元に戻す。戻せないものはそのまま返す
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

// 文字コードで書かれた名前（#U…）と文字化けを、元の名前に戻す
export function decodeStampName(text: string): string {
  return undoMojibake(text.replace(LEGACY_CODE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
}

// 比べるための正規の形（builtin:ファイル名）。「builtin:」が無いものも付けて返す
export function canonicalStampRef(ref: string): string {
  if (!ref.startsWith("builtin:")) return `builtin:${decodeStampName(ref)}`;
  return `builtin:${decodeStampName(ref.slice("builtin:".length))}`;
}

// 表示用の名前（拡張子を除く）
export function stampNameOf(ref: string): string {
  return canonicalStampRef(ref).slice("builtin:".length).replace(/\.[^.]+$/, "");
}
