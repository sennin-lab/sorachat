// 拡張機能のデータ保存の決まり（DB には触れない純粋な関数だけ）。
export const STORAGE = {
  keyMax: 64,
  valueMaxBytes: 16 * 1024, // 1つの値（JSON の大きさ）
  keysMax: 200, // 1つの拡張機能・1人あたりの件数
  writesPerMinute: 60 // 1人が1分間に書ける回数（連打・暴走の防止）
} as const;

export const STORAGE_KEY = /^[A-Za-z0-9_.:-]+$/;

export function checkKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0 || key.length > STORAGE.keyMax) {
    return `キーは 1〜${STORAGE.keyMax} 文字で指定してください。`;
  }
  if (!STORAGE_KEY.test(key)) return "キーには英数字と _ . : - だけ使えます。";
  return null;
}

// 値は JSON にできるものだけ。大きさの上限を超えたら断る
export function checkValue(value: unknown): { ok: true } | { ok: false; error: string } {
  if (value === undefined) return { ok: false, error: "保存する値を指定してください。" };
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { ok: false, error: "保存する値を読み取れませんでした。" };
  }
  if (json === undefined) return { ok: false, error: "保存する値を読み取れませんでした。" };
  if (Buffer.byteLength(json, "utf8") > STORAGE.valueMaxBytes) {
    return { ok: false, error: `1つの値は ${STORAGE.valueMaxBytes / 1024}KB までです。` };
  }
  return { ok: true };
}
