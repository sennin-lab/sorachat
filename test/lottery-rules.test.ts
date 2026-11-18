// 宝くじの計算の検査（当たりの判定・賞金の検査・一桁ずつの公開・日本時間の日付）。
// 実行: npm run test:lottery（tsx で動く。DB もネットワークも使わない）
import assert from "node:assert/strict";
import { drawNumber, finishesAtMs, isCalendarDate, revealedCount, statusOf, tierOf, todayJst, validatePrizes } from "../server/lotteryRules.js";

// 当たりの判定：等 t は末尾 (桁数+1-t) 桁が一致すれば当たり。上の等を優先する
assert.equal(tierOf("4821", "4821", 3), 1, "全桁一致は 1等");
assert.equal(tierOf("0821", "4821", 3), 2, "末尾3桁一致は 2等");
assert.equal(tierOf("0021", "4821", 3), 3, "末尾2桁一致は 3等");
assert.equal(tierOf("0000", "4821", 3), null, "どこも合わなければ外れ");
assert.equal(tierOf("0821", "4821", 1), null, "1等までの宝くじでは、2等の一致は当たらない");
assert.equal(tierOf("4821", "4821", 1), 1, "1等だけの宝くじでも全桁一致は当たる");
assert.equal(tierOf("1821", "4821", 4), 2, "2等は末尾3桁で判定する");

// 賞金の検査
assert.equal(validatePrizes(4, [10_000, 1_000, 100]), null, "上の等ほど多い並びは正しい");
assert.equal(validatePrizes(4, [1_000, 1_000]), null, "同じ額は許す");
assert.ok(validatePrizes(4, []), "等が無いのは不正");
assert.ok(validatePrizes(3, [100, 200]), "下の等が上の等より多いのは不正");
assert.ok(validatePrizes(3, [400, 300, 200, 100]), "等の数は桁数までしか作れない");
assert.ok(validatePrizes(4, [1.5]), "小数の賞金は不正");
assert.ok(validatePrizes(4, [0]), "0pt の賞金は不正");
assert.ok(validatePrizes(4, [10_000_001]), "上限を超える賞金は不正");

// 一桁ずつの公開（発表の時刻から、3秒ごと）
const T0 = Date.parse("2026-11-18T12:00:00+09:00");
assert.equal(revealedCount(T0, T0, 4), 0, "発表の瞬間は、まだ1桁も見せない");
assert.equal(revealedCount(T0, T0 + 2_999, 4), 0, "3秒未満は0桁");
assert.equal(revealedCount(T0, T0 + 3_000, 4), 1, "3秒で1桁目");
assert.equal(revealedCount(T0, T0 + 9_000, 4), 3, "9秒で3桁目");
assert.equal(revealedCount(T0, T0 + 999_999, 4), 4, "全部の桁を超えても、桁数で止まる");
assert.equal(revealedCount(T0, T0 - 1, 4), 0, "発表前は0桁");
assert.equal(finishesAtMs(T0, 4), T0 + 12_000, "4桁なら 12秒で全部見せ終わる");

// 状態：販売中 → 公開中 → 結果確定
assert.equal(statusOf(null, 4, T0), "selling", "発表前は販売中");
assert.equal(statusOf(T0, 4, T0 + 11_999), "revealing", "最後の桁の前は公開中");
assert.equal(statusOf(T0, 4, T0 + 12_000), "done", "全部見せたら結果確定");

// 券の番号は、桁数ぶんの 0埋めの数字
for (let i = 0; i < 200; i++) {
  const n = drawNumber(5);
  assert.equal(n.length, 5, "桁数どおり");
  assert.match(n, /^\d{5}$/, "数字だけ");
}

// 日本時間の日付（UTC の 15:00 は、日本時間では翌日の 0:00）
assert.equal(todayJst(Date.parse("2026-11-18T14:59:00Z")), "2026-11-18", "日本時間 23:59 はまだ当日");
assert.equal(todayJst(Date.parse("2026-11-18T15:00:00Z")), "2026-11-19", "日本時間 0:00 で日付が変わる");

// 日付の検査
assert.equal(isCalendarDate("2026-11-18"), true);
assert.equal(isCalendarDate("2026-02-30"), false, "存在しない日は不正");
assert.equal(isCalendarDate("2026-1-1"), false, "形が違うものは不正");

console.log("lottery-rules: all checks passed");
