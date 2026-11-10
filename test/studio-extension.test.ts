// 拡張機能（HTML・CSS・JS）の検査と、隔離して表示する文書の確認。実際のSupabaseには接続しない。
import assert from "node:assert/strict";
import { buildExtensionDocument, checkExtension, EXT_TOTAL_MAX, EXTENSION_CSP } from "../server/studioRules.ts";

const good = checkExtension({ html: "<button id=b>押す</button><p id=n>0</p>", css: "button{padding:8px}", js: "let c=0;document.getElementById('b').onclick=()=>{c++;document.getElementById('n').textContent=c}" });
assert.ok(good.ok);

// どれも空ならだめ。CSS だけでもだめ
assert.equal(checkExtension({ html: "", css: "a{}", js: "" }).ok, false);
assert.equal(checkExtension(null).ok, false);

// 埋め込み・外のサイトの画像や読み込み（許可した配信元以外）
assert.equal(checkExtension({ html: '<iframe src="x"></iframe>', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: '<img src="https://example.com/a.png">', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "a{background:url(//cdn.example.com/a.png)}", js: "" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: '@import "a.css";', js: "" }).ok, false);
assert.equal(checkExtension({ html: '<script src="https://evil.example/x.js"></script>', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "var u='https://evil.example/a'" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "var u='wss://cdnjs.cloudflare.com/a'" }).ok, false);
// 相対の読み込み・ホストに似せた名前（cdnjs.cloudflare.com.evil.example）は使えない
assert.equal(checkExtension({ html: '<script src="a.js"></script>', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: '<script src="https://cdnjs.cloudflare.com.evil.example/x.js"></script>', css: "", js: "" }).ok, false);

// 配信元のライブラリ（cdnjs・jsdelivr・unpkg など）は読み込める
const lib = checkExtension({
  html: '<script src="https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js"></script><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP">',
  css: "p{font-family:'Noto Sans JP'}",
  js: "var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';document.head.appendChild(s);"
});
assert.ok(lib.ok, lib.ok ? "" : lib.error);

// 通信・親ページ
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "fetch('/api/me')" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "new WebSocket('a')" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "window.parent.document" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "navigator.sendBeacon('a')" }).ok, false);

// 大きさ：HTML・CSS・JavaScript を合わせて 15万文字まで（種類ごとの上限はない）
assert.equal(EXT_TOTAL_MAX, 150_000);
assert.equal(checkExtension({ html: "a".repeat(60_001), css: "", js: "" }).ok, true);
assert.equal(checkExtension({ html: "a".repeat(50_000), css: "b".repeat(50_000), js: "c".repeat(50_000) }).ok, true);
assert.equal(checkExtension({ html: "a".repeat(50_000), css: "b".repeat(50_000), js: "c".repeat(50_001) }).ok, false);

// 配信用の文書：スクリプトを閉じる文字列で枠が壊れない・CSP は通信を止めて sandbox を付ける
const doc = buildExtensionDocument({ html: "<p>a</p>", css: "p{}</style><b>", js: "var s='</script><b>'" });
assert.ok(doc.includes("<p>a</p>"));
assert.ok(!doc.includes("</style><b>"));
assert.ok(!doc.includes("</script><b>"));
assert.ok(EXTENSION_CSP.includes("sandbox allow-scripts"));
assert.ok(EXTENSION_CSP.includes("connect-src 'none'"));
assert.ok(EXTENSION_CSP.includes("https://cdnjs.cloudflare.com"));
assert.ok(!EXTENSION_CSP.split(/[;\s]+/).includes("https:"), "CSP に https: の全許可は入れない");
assert.ok(!EXTENSION_CSP.includes("allow-same-origin"));

console.log("studio-extension: ok");
