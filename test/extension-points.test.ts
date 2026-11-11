import "./env.ts";
// 拡張機能のポイント配布（ブリッジ）と、利用者の情報の許可の検査。実際のSupabaseには接続しない。
import assert from "node:assert/strict";
import { checkAwardRequest, checkChargeRequest, extensionSpecMarkdown } from "../server/extensionPoints.ts";
import { buildExtensionDocument, EXT_BRIDGE, EXTENSION_CSP } from "../server/studioRules.ts";

// 配布の依頼：範囲・整数・理由の長さ・requestId の形
const good = checkAwardRequest({ amount: 10, reason: "クリア", requestId: "clear-0001" });
assert.equal(good.ok, true);
assert.equal(checkAwardRequest({ amount: 0, requestId: "clear-0001" }).ok, false);
assert.equal(checkAwardRequest({ amount: EXT_BRIDGE.awardMaxPerCall + 1, requestId: "clear-0001" }).ok, false);
assert.equal(checkAwardRequest({ amount: 1.5, requestId: "clear-0001" }).ok, false);
assert.equal(checkAwardRequest({ amount: "10", requestId: "clear-0001" }).ok, false);
assert.equal(checkAwardRequest({ amount: 10, reason: "x".repeat(EXT_BRIDGE.reasonMax + 1), requestId: "clear-0001" }).ok, false);
assert.equal(checkAwardRequest({ amount: 10, requestId: "short" }).ok, false);
assert.equal(checkAwardRequest({ amount: 10, requestId: "has space here" }).ok, false);
assert.equal(checkAwardRequest({ amount: 10, requestId: "a".repeat(EXT_BRIDGE.requestIdMax + 1) }).ok, false);
assert.equal(checkAwardRequest({ amount: 10 }).ok, false);
assert.equal(checkAwardRequest(null).ok, false);
// 最大・最小ちょうどは通る
assert.equal(checkAwardRequest({ amount: EXT_BRIDGE.awardMaxPerCall, requestId: "clear-0001" }).ok, true);
assert.equal(checkAwardRequest({ amount: EXT_BRIDGE.awardMin, requestId: "clear-0001", reason: "" }).ok, true);

// ブリッジ：枠の中のコードより先に読み込まれ、構文が正しい（ユーザーのコードが壊さない）
const doc = buildExtensionDocument({ html: "<p>x</p>", css: "", js: "window.__user = 1;" });
const scripts = [...doc.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
const bridgeIndex = scripts.findIndex((s) => s.includes("window.sorachat"));
const userIndex = scripts.findIndex((s) => s.includes("window.__user"));
assert.ok(bridgeIndex >= 0, "ブリッジが文書に入っている");
assert.ok(bridgeIndex < userIndex, "ブリッジはユーザーのコードより先に読み込まれる");
for (const code of scripts) {
  assert.doesNotThrow(() => new Function(code), "スクリプトの構文が正しい");
}
assert.ok(doc.includes(EXT_BRIDGE.channel), "チャンネル名が文書に入っている");

// 隔離は変わらない：CSP の sandbox・通信禁止はそのまま
assert.ok(EXTENSION_CSP.startsWith("sandbox allow-scripts;"));
assert.ok(EXTENSION_CSP.includes("connect-src 'none'"));
assert.ok(!EXTENSION_CSP.includes("allow-same-origin"));

// 仕様書：上の定数（上限・名前・code）と食い違わない
const spec = extensionSpecMarkdown();
assert.ok(spec.includes(`${EXT_BRIDGE.awardMaxPerCall}`), "1回の上限を書いている");
assert.ok(spec.includes("window.sorachat.awardPoints"));
assert.ok(spec.includes("window.sorachat.getAccount"));
assert.ok(spec.includes("window.sorachat.requestAccess"));
for (const code of ["not_consented", "not_linked", "exhausted", "inactive", "rate_limited", "unknown", "timeout"]) {
  assert.ok(spec.includes(code), `エラーの code ${code} を書いている`);
}

console.log("extension-points: ok");

// 支払い（拡張機能の中のポイント支払い）：金額・品名・requestId の形
assert.equal(checkChargeRequest({ amount: 100, title: "ヒント", requestId: "charge-0001" }).ok, true);
assert.equal(checkChargeRequest({ amount: EXT_BRIDGE.chargeMin - 1, title: "ヒント", requestId: "charge-0001" }).ok, false);
assert.equal(checkChargeRequest({ amount: 10.5, title: "ヒント", requestId: "charge-0001" }).ok, false);
assert.equal(checkChargeRequest({ amount: "10", title: "ヒント", requestId: "charge-0001" }).ok, false);
assert.equal(checkChargeRequest({ amount: 10, title: "", requestId: "charge-0001" }).ok, false);
assert.equal(checkChargeRequest({ amount: 10, title: "x".repeat(EXT_BRIDGE.chargeTitleMax + 1), requestId: "charge-0001" }).ok, false);
assert.equal(checkChargeRequest({ amount: 10, title: "ヒント", requestId: "short" }).ok, false);
assert.equal(checkChargeRequest({ amount: 10, title: "ヒント" }).ok, false);

// ブリッジには支払いの窓口があり、枠の中の支払いは確認画面を経由する（ブリッジから直接は払えない＝サーバーへの直接の通信は CSP で止まる）
assert.ok(doc.includes("charge: function"), "支払いの窓口がブリッジにある");
assert.ok(doc.includes("CONFIG.chargeTimeoutMs"), "支払いは確認を待つ長さで待つ");
assert.ok(extensionSpecMarkdown().includes("window.sorachat.charge(amount, title, requestId)"), "仕様に支払いが書いてある");

// 1分あたりの上限（1人・1分間に受け取れるポイント）と、拡張機能内課金の実装手順：仕様書に書いてある
assert.ok(spec.includes("minute_limit"), "1分あたりの上限のエラー code を書いている");
assert.ok(spec.includes("1人が1分間に受け取れるポイントにも上限"), "1分あたりの上限を書いている");
assert.ok(spec.includes("拡張機能内課金の実装手順"), "課金の実装手順を書いている");
assert.ok(spec.includes("拡張機能内課金の完全な例"), "課金の完全な例を書いている");
assert.ok(spec.includes("localStorage"), "枠の中で購入状態を保存できないことを書いている");
assert.ok(!spec.includes("${"), "仕様書に未展開の式が残っていない");

console.log("extension-points: charge and minute limit ok");
