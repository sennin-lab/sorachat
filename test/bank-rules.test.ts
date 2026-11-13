// SenninBank の計算（利息・配当の割り方・利率の読み方）の検査。
// 実行: npm run test:bank（tsx で動く。DB もネットワークも使わない）
import assert from "node:assert/strict";
import { bankRates, dividendPool, dividendShare, interestSince, readRate } from "../server/bankRules.js";

const DAY = 86_400_000;

// 利息：元本 × 日利 × 経過日数（単利）
assert.equal(interestSince(10_000, 0.0002, 0, DAY), 2, "1日で 10,000pt の 0.02% は 2pt");
assert.equal(interestSince(10_000, 0.0002, 0, DAY / 2), 1, "半日なら半分");
assert.equal(interestSince(0, 0.0002, 0, DAY), 0, "預金が無ければ利息は無い");
assert.equal(interestSince(10_000, 0, 0, DAY), 0, "利率 0 なら利息は無い");
assert.equal(interestSince(10_000, 0.0002, DAY, 0), 0, "時計が戻っても、負の利息にはならない");

// 利息は、途中で分けて確定しても合計が同じ（単利なので経過時間だけで決まる）
const whole = interestSince(5_000, 0.001, 0, 3 * DAY);
const parts = interestSince(5_000, 0.001, 0, DAY) + interestSince(5_000, 0.001, DAY, 3 * DAY);
assert.ok(Math.abs(whole - parts) < 1e-9, "分けて確定しても同じ");

// 配当の額：売上の割合を、切り捨てた整数 pt
assert.equal(dividendPool(100, 0.1), 10);
assert.equal(dividendPool(15, 0.1), 1, "端数は切り捨て");
assert.equal(dividendPool(9, 0.1), 0, "小さい売上は配当が 0");

// 投資額の割合で分ける（切り捨て）。端数は作者に残る
const pool = dividendPool(100, 0.1); // 10
const amounts = [1, 1, 1];
const total = amounts.reduce((s, v) => s + v, 0);
const shares = amounts.map((a) => dividendShare(pool, a, total));
assert.deepEqual(shares, [3, 3, 3], "10pt を3人に割ると 3pt ずつ（残り1pt は作者へ）");
assert.ok(shares.reduce((s, v) => s + v, 0) <= pool, "配った合計は配当の総額を超えない");

// 投資額の比率どおりに分かれる
assert.equal(dividendShare(100, 300, 1000), 30);
assert.equal(dividendShare(100, 700, 1000), 70);
assert.equal(dividendShare(100, 0, 1000), 0, "投資していない人には配らない");
assert.equal(dividendShare(0, 500, 1000), 0, "配当の総額が 0 なら配らない");

// 保有者が多くても、配った合計は必ず配当の総額以下（どんな投資の組み合わせでも超えない）
for (let trial = 0; trial < 500; trial++) {
  const gross = 1 + Math.floor(Math.random() * 5000);
  const p = dividendPool(gross, 0.25);
  const holders = Array.from({ length: 1 + Math.floor(Math.random() * 12) }, () => 1 + Math.floor(Math.random() * 900));
  const sum = holders.reduce((s, v) => s + v, 0);
  const given = holders.reduce((s, v) => s + dividendShare(p, v, sum), 0);
  assert.ok(given <= p, `配った合計 ${given} が配当 ${p} を超えた`);
  assert.ok(gross - given > 0, "作者の受け取りは必ず 1pt 以上残る");
}

// 環境変数の読み方（不正な値は既定値、上限・下限を守る）
assert.equal(readRate(undefined, 0.2, 1), 0.2);
assert.equal(readRate("", 0.2, 1), 0.2);
assert.equal(readRate("abc", 0.2, 1), 0.2);
assert.equal(readRate("0.5", 0.2, 1), 0.5);
assert.equal(readRate("9", 0.2, 1), 1, "上限で止まる");
assert.equal(readRate("-3", 0.2, 1), 0, "下限は 0");

const rates = bankRates({ BANK_DAILY_RATE: "0.0003", BANK_DIVIDEND_RATE: "0.9" });
assert.equal(rates.dailyRate, 0.0003);
assert.equal(rates.dividendRate, 0.5, "配当は最大 50%");
const defaults = bankRates({});
assert.equal(defaults.dailyRate, 0.0002);
assert.equal(defaults.dividendRate, 0.1);

console.log("bank-rules: all checks passed");
