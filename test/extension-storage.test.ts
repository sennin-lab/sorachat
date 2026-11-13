import "./env.ts";
// 拡張機能のデータ保存の決まり（キー・値の大きさ）を確かめる。実際のSupabaseには接続しない。
import assert from "node:assert/strict";
import { checkKey, checkValue, STORAGE } from "../server/extensionStorageRules.ts";

assert.equal(checkKey("score"), null);
assert.equal(checkKey("stage.1:best_score-2"), null);
assert.notEqual(checkKey(""), null, "空のキーは不可");
assert.notEqual(checkKey("a".repeat(STORAGE.keyMax + 1)), null, "長すぎるキーは不可");
assert.equal(checkKey("a".repeat(STORAGE.keyMax)), null, "上限ちょうどは可");
assert.notEqual(checkKey("日本語"), null, "日本語のキーは不可");
assert.notEqual(checkKey("a/b"), null, "スラッシュは不可（URLを壊すため）");
assert.notEqual(checkKey(3), null);

assert.equal(checkValue({ level: 3, tags: ["a"] }).ok, true);
assert.equal(checkValue(null).ok, true, "null は保存できる");
assert.equal(checkValue(undefined).ok, false, "未指定は不可");
assert.equal(checkValue("x".repeat(STORAGE.valueMaxBytes + 10)).ok, false, "上限を超える値は不可");
const circular: Record<string, unknown> = {};
circular.self = circular;
assert.equal(checkValue(circular).ok, false, "循環する値は不可");

console.log("extension storage tests: all passed");
