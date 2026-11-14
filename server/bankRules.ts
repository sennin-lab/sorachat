// SenninBank の計算（利息・配当の割り方）。
// DB の関数（supabase/schema_v43.sql）と同じ式にしてある。ここは外部に依存しない純粋な関数だけを置く（テストから直接読める）。

export const BANK_LIMITS = {
  // 投資の最小額（pt）
  minInvest: 10,
  // 1回に動かせる最大額（pt）
  maxAmount: 1_000_000,
  // ランキングの表示人数
  rankingSize: 10
} as const;

// 作者は、売上の必ずこの割合以上を受け取る（配当は残りの半分まで）。最低でも 1pt は作者に残る。
export const DEV_MIN_KEEP_RATIO = 0.5;

// 環境変数の値を 0〜max の数に直す。空や不正な値のときは既定値。
export function readRate(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), max);
}

// 0 以上の整数の環境変数（投資額の単位など）。
export function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(Math.floor(n), 0);
}

// 利率を読む。呼ぶたびに環境変数を読むので、再起動なしでも次の呼び出しから反映される
export function bankRates(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return {
    // 預金の利息（日利。0.0002 = 0.02%/日 ≒ 年 7.3%、単利）
    dailyRate: readRate(env.BANK_DAILY_RATE, 0.0002, 0.01),
    // 配当率の下限：作者の売上から、投資がほとんど無いときに配る割合（0.1 = 10%）
    dividendRate: readRate(env.BANK_DIVIDEND_RATE, 0.1, 0.5),
    // 配当率の上限：作者への投資の総額が「満額の投資額」に届いたときの割合（0.3 = 30%）。下限より小さくはしない
    dividendMaxRate: readRate(env.BANK_DIVIDEND_MAX_RATE, 0.3, 0.5),
    // 満額とみなす投資の総額（pt）。これに届くまで、投資が増えるほど配当率が上がる
    dividendScale: readNonNegativeInt(env.BANK_DIVIDEND_SCALE, 10_000),
    // 投資家ごとの取り分の指数（1 = 投資額の割合どおり。1 より大きいと、多く入れた人ほど割合が上がる）
    dividendExponent: readRate(env.BANK_DIVIDEND_EXPONENT, 1.2, 2)
  };
}

// 前回の確定から今までの利息（元本 × 日利 × 経過秒 / 86400）
export function interestSince(principal: number, dailyRate: number, lastAccruedMs: number, nowMs: number): number {
  if (principal <= 0 || dailyRate <= 0) return 0;
  const elapsedSeconds = Math.max((nowMs - lastAccruedMs) / 1000, 0);
  return (principal * dailyRate * elapsedSeconds) / 86_400;
}

// 作者への投資の総額に応じた配当率。投資が 0 なら下限、scale に届くまで直線的に上限へ近づく。
export function dividendRateFor(totalInvested: number, base: number, max: number, scale: number): number {
  const top = Math.max(base, max);
  if (scale <= 0 || totalInvested <= 0) return base;
  const ratio = Math.min(totalInvested / scale, 1);
  return base + (top - base) * ratio;
}

// 売上から株主配当として差し引く額（整数の pt。切り捨て）。
// 作者の受け取りは必ず DEV_MIN_KEEP_RATIO 以上（最低 1pt）残るように、配当の上限をここで止める。
export function dividendPool(gross: number, dividendRate: number): number {
  if (gross <= 0) return 0;
  const rate = Math.min(Math.max(dividendRate, 0), 1 - DEV_MIN_KEEP_RATIO);
  const devKeepAtLeast = Math.max(1, Math.ceil(gross * DEV_MIN_KEEP_RATIO));
  return Math.max(0, Math.min(Math.floor(gross * rate), gross - devKeepAtLeast));
}

// 投資額に応じた、配当の取り分（切り捨て）。total は作者への投資の合計
export function dividendShare(pool: number, amount: number, total: number): number {
  if (pool <= 0 || amount <= 0 || total <= 0) return 0;
  return Math.floor((pool * amount) / total);
}

// 投資家ごとの重み（投資額の指数乗）。0 以下の投資は重みを 0 にする（指数が 0 でも、投資していない人には配らない）
export function dividendWeight(amount: number, exponent: number): number {
  if (amount <= 0) return 0;
  return Math.pow(amount, exponent);
}

// 投資家ごとの取り分（整数の pt。切り捨て）。合計は必ず pool 以下。端数は作者に残る。
export function dividendShares(pool: number, amounts: number[], exponent: number): number[] {
  const weights = amounts.map((a) => dividendWeight(a, exponent));
  const sum = weights.reduce((s, w) => s + w, 0);
  if (pool <= 0 || sum <= 0) return amounts.map(() => 0);
  // 浮動小数点の誤差（99.9999… になる）を避けるため、ごく小さい値を足してから切り捨てる
  const shares = weights.map((w) => Math.floor((pool * w) / sum + 1e-9));
  // 念のため合計が配当を超えないように、超えた分は大きい取り分から引く
  let excess = shares.reduce((s, v) => s + v, 0) - pool;
  while (excess > 0) {
    const i = shares.indexOf(Math.max(...shares));
    const cut = Math.min(excess, shares[i]);
    shares[i] -= cut;
    excess -= cut;
  }
  return shares;
}
