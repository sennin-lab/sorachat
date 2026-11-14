// 連打の練度（累計の回数で上限が増える）の検査。DB もネットワークも使わない。
import assert from "node:assert/strict";
import { tapCapOf, tapLevelOf, tapMaxRun, TAP_MAX_PER_SECOND, TAP_GRACE, TAP_PER_SECOND_CEIL } from "../server/gameLogic.js";

// 練度 0（はじめて）は、今までどおり（秒 14・余裕 15）
assert.equal(tapLevelOf(0), 0);
assert.deepEqual(tapCapOf(0), { level: 0, perSecond: TAP_MAX_PER_SECOND, grace: TAP_GRACE });
assert.equal(tapMaxRun(tapCapOf(0)), 155, "はじめての人の最大（10秒で155回）");

// 累計が増えるほど、レベルと上限が上がる（単調増加）
let prev = -1;
let prevMax = -1;
for (const taps of [0, 299, 300, 999, 1000, 2500, 6000, 12000, 25000, 50000, 10_000_000]) {
  const level = tapLevelOf(taps);
  assert.ok(level >= prev, "レベルは下がらない");
  const max = tapMaxRun(tapCapOf(taps));
  assert.ok(max >= prevMax, "上限は下がらない");
  prev = level;
  prevMax = max;
}
assert.equal(tapLevelOf(299), 0);
assert.equal(tapLevelOf(300), 1, "300 回で レベル1");
assert.equal(tapLevelOf(10_000_000), 7, "最高は レベル7");
assert.ok(tapMaxRun(tapCapOf(10_000_000)) > tapMaxRun(tapCapOf(0)) + 40, "極めると明確に増える");

// 秒あたりの上限は、人の指の限界より上に行き過ぎない
assert.ok(tapCapOf(10_000_000).perSecond <= TAP_PER_SECOND_CEIL);

console.log("tap-mastery: all checks passed");
