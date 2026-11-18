// 宝くじの計算（券の番号・当たりの判定・桁ごとの公開の進み方）。
// DB も外部も使わない純粋な関数だけを置く（テストから直接読める）。
import { randomInt } from "node:crypto";

export const LOTTERY = {
  // 1券の値段（pt）
  ticketPrice: 1000,
  // 1回の購入で買える枚数
  maxQuantityPerRequest: 10,
  // 1人が1つの宝くじで持てる券の上限
  maxTicketsPerUser: 100,
  minDigits: 3,
  maxDigits: 8,
  maxTiers: 8,
  // 賞金（pt）の上限
  maxPrize: 10_000_000,
  nameMax: 40,
  // 1桁を公開する間隔（ミリ秒）。ゆっくり一桁ずつ見せる
  revealStepMs: 3_000
} as const;

// 当選番号を引く（桁数ぶんの 0〜9 を、暗号的に安全な乱数で決める）
export function drawNumber(digits: number): string {
  return randomInt(0, 10 ** digits).toString().padStart(digits, "0");
}

// 何等か。等 t（1始まり）は、末尾 (桁数 + 1 - t) 桁が当選番号と一致すれば当たり。
// 1等は全桁、2等は末尾の一桁少なく、というふうに下の等ほど当たりやすい。
// 1枚の券は、当たった中で一番上の等だけを受け取る。当たらなければ null。
export function tierOf(ticket: string, winning: string, tierCount: number): number | null {
  const digits = winning.length;
  for (let tier = 1; tier <= tierCount; tier++) {
    const k = digits + 1 - tier;
    if (k <= 0) break;
    if (ticket.slice(-k) === winning.slice(-k)) return tier;
  }
  return null;
}

// 各等の賞金を検査する。問題があれば日本語のメッセージを返す（問題がなければ null）
export function validatePrizes(digits: number, prizes: number[]): string | null {
  if (prizes.length < 1) return "等を1つ以上決めてください。";
  if (prizes.length > Math.min(digits, LOTTERY.maxTiers)) return `等は${Math.min(digits, LOTTERY.maxTiers)}等までです。`;
  for (const p of prizes) {
    if (!Number.isInteger(p) || p < 1 || p > LOTTERY.maxPrize) return `賞金は1〜${LOTTERY.maxPrize.toLocaleString("ja-JP")}ptの整数で入れてください。`;
  }
  for (let i = 1; i < prizes.length; i++) {
    if (prizes[i] > prizes[i - 1]) return "下の等ほど賞金が少なくなるように入れてください。";
  }
  return null;
}

// 公開済みの桁数（発表の時刻から、一桁ごとに増える。0 〜 桁数）
export function revealedCount(announcedAtMs: number, nowMs: number, digits: number): number {
  const elapsed = nowMs - announcedAtMs;
  if (elapsed < 0) return 0;
  return Math.min(digits, Math.floor(elapsed / LOTTERY.revealStepMs));
}

// 全部の桁を見せ終わる時刻（ミリ秒）。ここから「結果が決まった」状態になる
export function finishesAtMs(announcedAtMs: number, digits: number): number {
  return announcedAtMs + digits * LOTTERY.revealStepMs;
}

export type LotteryStatus = "selling" | "revealing" | "done";

// 今の状態：販売中（発表前）→ 公開中（一桁ずつ）→ 結果確定
export function statusOf(announcedAtMs: number | null, digits: number, nowMs: number): LotteryStatus {
  if (announcedAtMs === null) return "selling";
  return nowMs >= finishesAtMs(announcedAtMs, digits) ? "done" : "revealing";
}

// 日本時間の今日（YYYY-MM-DD）
export function todayJst(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 「YYYY-MM-DD」の実在する日付か
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
