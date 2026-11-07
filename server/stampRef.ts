// スタンプの指定（ref）を正規化する。
// 以前は名前が「#U3042#U308a…」のように文字コードで書かれたものがあったため、それを元の文字に戻す。
// 保存・返却の前にここを通すことで、古いメッセージも今の名前で扱えるようにする。
// 文字化けした名前（「╧Ç├╝├ñ…」など）で送られたものも、元の日本語名に戻す。
// クライアントと同じ変換（src/stamps/index.ts と揃えておく）
const LEGACY_CODE = /#U([0-9a-fA-F]{4})/g;

// 文字化けした名前の読み替え。
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

export function normalizeStampRef(ref: string): string {
  return undoMojibake(ref.replace(LEGACY_CODE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
}
