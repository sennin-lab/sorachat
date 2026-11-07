// senninstudio の自動チェック（審査なしで公開するための仕組み）。
// DB や通信には触れない純粋な関数だけを置く（テストしやすいように）。

export const STUDIO_KINDS = ["stamp_pack", "theme", "quiz", "ai_style"] as const;
export type StudioKind = (typeof STUDIO_KINDS)[number];

export const PRICE_MIN = 10;
export const PRICE_MAX = 1000;
export const STAMP_MAX_COUNT = 24;
export const STAMP_MAX_BYTES = 1024 * 1024; // 1MB
export const THUMB_MAX_BYTES = 2 * 1024 * 1024; // 2MB
export const STAMP_MAX_SIDE = 512;
export const STAMP_MIN_SIDE = 16;
export const QUIZ_MIN_QUESTIONS = 5; // 対戦の5問に足りるように
export const QUIZ_MAX_QUESTIONS = 50;

// 禁止語（最低限の例）。運営が増やしてください。ここに当たる文字列は公開できません。
export const BLOCKED_WORDS = ["死ね", "殺してやる", "自殺しろ"];

// ---------- 画像 ----------

export type SniffedImage = { type: "png" | "gif" | "webp" | "jpeg"; width: number | null; height: number | null };

// ファイルの中身（先頭のバイト列）で形式を判定し、分かるなら縦横のピクセル数も読む。拡張子や申告の型は信用しない
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { type: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buf.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      return { type: "webp", width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") {
      return { type: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return { type: "webp", width: null, height: null };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: "jpeg", width: null, height: null };
  }
  return null;
}

// スタンプ画像: PNG・GIF・WebP のみ。縦横とも 16〜512px、1MB以下
export function checkStampImage(buf: Buffer): string | null {
  if (buf.length > STAMP_MAX_BYTES) return "スタンプ画像は1枚1MB以下にしてください。";
  const image = sniffImage(buf);
  if (!image || image.type === "jpeg") return "スタンプ画像は PNG・GIF・WebP のファイルにしてください。";
  if (image.width === null || image.height === null) return "スタンプ画像の大きさを読み取れませんでした。";
  if (image.width > STAMP_MAX_SIDE || image.height > STAMP_MAX_SIDE) return `スタンプ画像は縦横とも ${STAMP_MAX_SIDE}px 以下にしてください。`;
  if (image.width < STAMP_MIN_SIDE || image.height < STAMP_MIN_SIDE) return `スタンプ画像は縦横とも ${STAMP_MIN_SIDE}px 以上にしてください。`;
  return null;
}

// サムネイル: PNG・GIF・WebP・JPEG。2MB以下
export function checkThumbImage(buf: Buffer): string | null {
  if (buf.length > THUMB_MAX_BYTES) return "サムネイルは2MB以下にしてください。";
  const image = sniffImage(buf);
  if (!image) return "サムネイルは PNG・JPEG・GIF・WebP の画像にしてください。";
  return null;
}

// ---------- 文字 ----------

const URL_PATTERN = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|jp|io|app|xyz|top|info|biz)\b)/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// 電話番号らしい並び（ハイフンあり・なし、全角数字も含む）
const PHONE_PATTERN = /(0[0-9０-９]{1,4}[-－ー][0-9０-９]{1,4}[-－ー][0-9０-９]{3,4})|(0[789]0[0-9０-９]{8})/;

// 公開してよい文字列か。問題があれば理由を返す（外部への誘導・連絡先・禁止語を止める）
export function checkText(text: string, label: string): string | null {
  if (URL_PATTERN.test(text)) return `${label}にURLは書けません。`;
  if (EMAIL_PATTERN.test(text)) return `${label}にメールアドレスは書けません。`;
  if (PHONE_PATTERN.test(text)) return `${label}に電話番号は書けません。`;
  const lower = text.toLowerCase();
  if (BLOCKED_WORDS.some((word) => lower.includes(word))) return `${label}に不適切な言葉が含まれています。`;
  return null;
}

// ---------- 作品ごとの中身 ----------

const HEX = /^#[0-9a-fA-F]{6}$/;

export type ThemePayload = { mine: string; bg: string; accent: string };
export type QuizQuestionPayload = { q: string; options: string[]; answer: number };
export type QuizPayload = { questions: QuizQuestionPayload[] };
export const TONES = ["やさしい", "ていねい", "ふつう", "カジュアル"] as const;
export const LENGTHS = ["短め", "ふつう", "詳しめ"] as const;
export type AiStylePayload = { tone: (typeof TONES)[number]; length: (typeof LENGTHS)[number]; emoji: boolean };

export function checkTheme(value: unknown): { ok: true; payload: ThemePayload } | { ok: false; error: string } {
  const v = value as Partial<ThemePayload> | null;
  if (!v || typeof v !== "object") return { ok: false, error: "配色を入力してください。" };
  for (const key of ["mine", "bg", "accent"] as const) {
    if (typeof v[key] !== "string" || !HEX.test(v[key] as string)) {
      return { ok: false, error: "配色は「#RRGGBB」の形で入力してください。" };
    }
  }
  return { ok: true, payload: { mine: v.mine as string, bg: v.bg as string, accent: v.accent as string } };
}

export function checkQuiz(value: unknown): { ok: true; payload: QuizPayload } | { ok: false; error: string } {
  const list = (value as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return { ok: false, error: "問題を入力してください。" };
  if (list.length < QUIZ_MIN_QUESTIONS || list.length > QUIZ_MAX_QUESTIONS) {
    return { ok: false, error: `問題は${QUIZ_MIN_QUESTIONS}〜${QUIZ_MAX_QUESTIONS}問にしてください。` };
  }
  const questions: QuizQuestionPayload[] = [];
  for (const [index, raw] of list.entries()) {
    const item = raw as { q?: unknown; options?: unknown; answer?: unknown };
    const no = index + 1;
    if (typeof item.q !== "string" || !item.q.trim() || item.q.length > 100) {
      return { ok: false, error: `${no}問目の問題文は1〜100文字で入力してください。` };
    }
    if (!Array.isArray(item.options) || item.options.length !== 4) {
      return { ok: false, error: `${no}問目の選択肢は4つにしてください。` };
    }
    const options = item.options.map((o) => (typeof o === "string" ? o.trim() : ""));
    if (options.some((o) => !o || o.length > 30)) {
      return { ok: false, error: `${no}問目の選択肢は1〜30文字で入力してください。` };
    }
    if (new Set(options).size !== 4) return { ok: false, error: `${no}問目の選択肢に同じものがあります。` };
    if (typeof item.answer !== "number" || !Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) {
      return { ok: false, error: `${no}問目の正解を選んでください。` };
    }
    const textError = checkText(`${item.q} ${options.join(" ")}`, `${no}問目`);
    if (textError) return { ok: false, error: textError };
    questions.push({ q: item.q.trim(), options, answer: item.answer });
  }
  return { ok: true, payload: { questions } };
}

export function checkAiStyle(value: unknown): { ok: true; payload: AiStylePayload } | { ok: false; error: string } {
  const v = value as Partial<AiStylePayload> | null;
  if (!v || !(TONES as readonly string[]).includes(v.tone as string)) return { ok: false, error: "口調を選んでください。" };
  if (!(LENGTHS as readonly string[]).includes(v.length as string)) return { ok: false, error: "長さを選んでください。" };
  if (typeof v.emoji !== "boolean") return { ok: false, error: "絵文字の使い方を選んでください。" };
  return { ok: true, payload: { tone: v.tone as AiStylePayload["tone"], length: v.length as AiStylePayload["length"], emoji: v.emoji } };
}

// senninai の応答スタイルを、AI への指示の文にする（選択肢だけから作るので、自由文の指示は入らない）
export function aiStyleInstruction(style: AiStylePayload): string {
  const tone =
    style.tone === "やさしい" ? "やさしい口調で" : style.tone === "ていねい" ? "ていねいな言葉づかいで" : style.tone === "カジュアル" ? "くだけた親しみやすい口調で" : "";
  const length = style.length === "短め" ? "短く" : style.length === "詳しめ" ? "少し詳しく" : "";
  const emoji = style.emoji ? "絵文字を適度に使って" : "絵文字は使わずに";
  return `回答は${[tone, length].filter(Boolean).join("、")}、${emoji}答えてください。`;
}

// 価格の確認（10〜1000 の整数）
export function checkPrice(value: unknown): string | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < PRICE_MIN || n > PRICE_MAX) {
    return `価格は${PRICE_MIN}〜${PRICE_MAX}ptの整数で入力してください。`;
  }
  return null;
}

// 作品の名前・説明の検査（空・長さ・禁止の内容）
export function checkBasics(name: unknown, description: unknown): string | null {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40) return "作品の名前は1〜40文字で入力してください。";
  if (typeof description !== "string" || description.length > 300) return "説明は300文字以内にしてください。";
  return checkText(`${name} ${description}`, "作品の名前と説明");
}
