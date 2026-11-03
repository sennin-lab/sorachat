// スタンプの指定（ref）を正規化する。
// 以前は名前が「#U3042#U308a…」のように文字コードで書かれたものがあったため、それを元の文字に戻す。
// 保存・返却の前にここを通すことで、古いメッセージも今の名前で扱えるようにする。
const LEGACY_CODE = /#U([0-9a-fA-F]{4})/g;

export function normalizeStampRef(ref: string): string {
  return ref.replace(LEGACY_CODE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
