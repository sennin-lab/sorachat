// 投資額に応じた配当率と、作者の受け取りが 0 にならないことの検査。
// 実行: npx tsx test/bank-rules-v43.test.ts（DB もネットワークも使わない）
import assert from "node:assert/strict";
import { bankRates, dividendPool, dividendRateFor, dividendShares, DEV_MIN_KEEP_RATIO } from "../server/bankRules.js";

// 投資が無ければ下限、満額に届くと上限、その途中は直線的
assert.equal(dividendRateFor(0, 0.1, 0.3, 10_000), 0.1, "投資が無ければ下限");
assert.equal(dividendRateFor(5_000, 0.1, 0.3, 10_000), 0.2, "半分の投資で中間");
assert.equal(dividendRateFor(10_000, 0.1, 0.3, 10_000), 0.3, "満額で上限");
assert.equal(dividendRateFor(1_000_000, 0.1, 0.3, 10_000), 0.3, "満額を超えても上限のまま");
assert.equal(dividendRateFor(500, 0.1, 0.05, 10_000), 0.1, "上限が下限より小さければ下限にそろえる");
assert.equal(dividendRateFor(500, 0.1, 0.3, 0), 0.1, "scale が 0 なら下限");

// 投資が増えると、同じ売上でも配当が増える
const low = dividendPool(1000, dividendRateFor(1_000, 0.1, 0.3, 10_000));
const high = dividendPool(1000, dividendRateFor(10_000, 0.1, 0.3, 10_000));
assert.ok(high > low, "投資が多いほど配当が多い");
assert.equal(low, 120, "投資 1,000pt は率 12%");
assert.equal(high, 300);

// 作者の受け取りは、どんな率でも売上の半分以上・最低 1pt
for (const rate of [0, 0.1, 0.3, 0.5, 0.9, 1, 5]) {
  for (const gross of [0, 1, 2, 3, 10, 99, 1000, 123_457]) {
    const pool = dividendPool(gross, rate);
    assert.ok(pool >= 0, "配当は負にならない");
    if (gross > 0) {
      assert.ok(gross - pool >= 1, `rate=${rate} gross=${gross}: 作者が 0 になった`);
      assert.ok(gross - pool >= Math.ceil(gross * DEV_MIN_KEEP_RATIO), `rate=${rate} gross=${gross}: 半分を切った`);
    }
  }
}
assert.equal(dividendPool(1, 1), 0, "1pt の売上は作者にすべて残る");
assert.equal(dividendPool(2, 1), 1, "2pt の売上は 1pt まで配当");

// 環境変数の既定値と上限
const defaults = bankRates({});
assert.equal(defaults.dividendRate, 0.1);
assert.equal(defaults.dividendMaxRate, 0.3);
assert.equal(defaults.dividendScale, 10_000);
assert.equal(defaults.dividendExponent, 1.2);
const custom = bankRates({ BANK_DIVIDEND_RATE: "0.2", BANK_DIVIDEND_MAX_RATE: "0.9", BANK_DIVIDEND_SCALE: "5000" });
assert.equal(custom.dividendMaxRate, 0.5, "最大 50%");
assert.equal(custom.dividendScale, 5000);
assert.equal(bankRates({ BANK_DIVIDEND_SCALE: "-3" }).dividendScale, 0, "負の値は 0");

// 取り分：指数 1 は投資額の割合どおり
assert.deepEqual(dividendShares(100, [300, 700], 1), [30, 70]);
// 指数 1.2：多く入れた人の割合が増える（1:3 の投資 → 割合が 1:3 より大きい側へ）
const even = dividendShares(1000, [1000, 3000], 1);
const skewed = dividendShares(1000, [1000, 3000], 1.2);
assert.ok(skewed[1] > even[1], "多く入れた人の取り分が増える");
assert.ok(skewed[0] < even[0], "少なく入れた人の取り分は減る");
// 投資していない人には配らない、合計は配当以下、作者に端数が残る
assert.deepEqual(dividendShares(100, [0, 500], 1.5), [0, 100]);
for (let trial = 0; trial < 500; trial++) {
  const n = 1 + Math.floor(Math.random() * 10);
  const amounts = Array.from({ length: n }, () => Math.floor(Math.random() * 5000));
  const pool = Math.floor(Math.random() * 3000);
  const exp = Math.random() * 2;
  const got = dividendShares(pool, amounts, exp);
  assert.ok(got.reduce((s, v) => s + v, 0) <= pool, "配った合計は配当以下");
  got.forEach((v, i) => { if (amounts[i] === 0) assert.equal(v, 0); });
}

console.log("bank-rules-v43: all checks passed");
