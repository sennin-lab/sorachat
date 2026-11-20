// 拡張機能（HTML・CSS・JS）の検査と、隔離して表示する文書の確認。実際のSupabaseには接続しない。
import assert from "node:assert/strict";
import { buildExtensionDocument, checkExtension, EXT_TOTAL_MAX, EXTENSION_CSP } from "../server/studioRules.ts";

const good = checkExtension({ html: "<button id=b>押す</button><p id=n>0</p>", css: "button{padding:8px}", js: "let c=0;document.getElementById('b').onclick=()=>{c++;document.getElementById('n').textContent=c}" });
assert.ok(good.ok);

// どれも空ならだめ。CSS だけでもだめ
assert.equal(checkExtension({ html: "", css: "a{}", js: "" }).ok, false);
assert.equal(checkExtension(null).ok, false);

// 外部 URL・外部ライブラリ・CSS @import・通信 API は sandbox 内で利用できる。
assert.equal(checkExtension({ html: '<img src="https://example.com/a.png">', css: "", js: "" }).ok, true);
assert.equal(checkExtension({ html: '<script src="https://evil.example/x.js"></script>', css: "", js: "" }).ok, true);
assert.equal(checkExtension({ html: "<p>x</p>", css: '@import "https://example.com/a.css";', js: "" }).ok, true);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "fetch('https://example.com/api'); new WebSocket('wss://example.com/socket');" }).ok, true);
assert.equal(checkExtension({ html: '<iframe src="https://example.com"></iframe>', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: '<meta http-equiv="refresh" content="0;url=https://example.com">', css: "", js: "" }).ok, false);

// 大きさ：HTML・CSS・JavaScript を合わせて 15万文字まで（種類ごとの上限はない）
assert.equal(EXT_TOTAL_MAX, 150_000);
assert.equal(checkExtension({ html: "a".repeat(60_001), css: "", js: "" }).ok, true);
assert.equal(checkExtension({ html: "a".repeat(50_000), css: "b".repeat(50_000), js: "c".repeat(50_000) }).ok, true);
assert.equal(checkExtension({ html: "a".repeat(50_000), css: "b".repeat(50_000), js: "c".repeat(50_001) }).ok, false);

// 配信用の文書：スクリプトを閉じる文字列で枠が壊れない・CSP は sandbox を維持し HTTPS/WSS 通信を許可する
const doc = buildExtensionDocument({ html: "<p>a</p>", css: "p{}</style><b>", js: "var s='</script><b>'" });
assert.ok(doc.includes("<p>a</p>"));
assert.ok(!doc.includes("</style><b>"));
assert.ok(!doc.includes("</script><b>"));
assert.ok(EXTENSION_CSP.includes("sandbox allow-scripts"));
assert.ok(EXTENSION_CSP.includes("connect-src https: wss:"));
assert.ok(EXTENSION_CSP.includes("script-src 'unsafe-inline' https: data: blob:"));
assert.ok(!EXTENSION_CSP.includes("allow-same-origin"));
assert.ok(EXTENSION_CSP.includes("frame-src 'none'"));

console.log("studio-extension: ok");
