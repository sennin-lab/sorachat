// SenninBank の計算（利息・配当の割り方）。
// DB の関数（supabase/schema_v42.sql）と同じ式にしてある。ここは外部に依存しない純粋な関数だけを置く（テストから直接読める）。

export const BANK_LIMITS = {
  // 投資の最小額（pt）
  minInvest: 10,
  // 1回に動かせる最大額（pt）
  maxAmount: 1_000_000,
  // ランキングの表示人数
  rankingSize: 10
} as const;

// 環境変数の値を 0〜max の数に直す。空や不正な値のときは既定値。
export function readRate(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), max);
}

// 利率（BANK_DAILY_RATE・BANK_DIVIDEND_RATE）を読む。呼ぶたびに環境変数を読むので、再起動なしでも次の呼び出しから反映される
export function bankRates(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return {
    // 預金の利息（日利。0.0002 = 0.02%/日 ≒ 年 7.3%、単利）
    dailyRate: readRate(env.BANK_DAILY_RATE, 0.0002, 0.01),
    // 作者の売上から差し引いて投資家に配る割合（0.1 = 10%）。上限は 50%
    dividendRate: readRate(env.BANK_DIVIDEND_RATE, 0.1, 0.5)
  };
}

// 前回の確定から今までの利息（元本 × 日利 × 経過秒 / 86400）
export function interestSince(principal: number, dailyRate: number, lastAccruedMs: number, nowMs: number): number {
  if (principal <= 0 || dailyRate <= 0) return 0;
  const elapsedSeconds = Math.max((nowMs - lastAccruedMs) / 1000, 0);
  return (principal * dailyRate * elapsedSeconds) / 86_400;
}

// 売上から株主配当として差し引く額（整数の pt。切り捨て）
export function dividendPool(gross: number, dividendRate: number): number {
  return Math.floor(gross * dividendRate);
}

// 投資額に応じた、配当の取り分（切り捨て）。total は作者への投資の合計
export function dividendShare(pool: number, amount: number, total: number): number {
  if (pool <= 0 || amount <= 0 || total <= 0) return 0;
  return Math.floor((pool * amount) / total);
}
