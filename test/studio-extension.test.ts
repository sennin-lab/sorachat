// 拡張機能（HTML・CSS・JS）の検査と、隔離して表示する文書の確認。実際のSupabaseには接続しない。
import assert from "node:assert/strict";
import { buildExtensionDocument, checkExtension, EXTENSION_CSP } from "../server/studioRules.ts";

const good = checkExtension({ html: "<button id=b>押す</button><p id=n>0</p>", css: "button{padding:8px}", js: "let c=0;document.getElementById('b').onclick=()=>{c++;document.getElementById('n').textContent=c}" });
assert.ok(good.ok);

// どれも空ならだめ。CSS だけでもだめ
assert.equal(checkExtension({ html: "", css: "a{}", js: "" }).ok, false);
assert.equal(checkExtension(null).ok, false);

// 外部の読み込み・埋め込み
assert.equal(checkExtension({ html: '<iframe src="x"></iframe>', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: '<script src="a.js"></script>', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: '<img src="https://example.com/a.png">', css: "", js: "" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "a{background:url(//cdn.example.com/a.png)}", js: "" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: '@import "a.css";', js: "" }).ok, false);

// 通信・親ページ
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "fetch('/api/me')" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "new WebSocket('a')" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "window.parent.document" }).ok, false);
assert.equal(checkExtension({ html: "<p>x</p>", css: "", js: "navigator.sendBeacon('a')" }).ok, false);

// 大きさ
assert.equal(checkExtension({ html: "a".repeat(60_001), css: "", js: "" }).ok, false);

// 配信用の文書：スクリプトを閉じる文字列で枠が壊れない・CSP は通信を止めて sandbox を付ける
const doc = buildExtensionDocument({ html: "<p>a</p>", css: "p{}</style><b>", js: "var s='</script><b>'" });
assert.ok(doc.includes("<p>a</p>"));
assert.ok(!doc.includes("</style><b>"));
assert.ok(!doc.includes("</script><b>"));
assert.ok(EXTENSION_CSP.includes("sandbox allow-scripts"));
assert.ok(EXTENSION_CSP.includes("connect-src 'none'"));
assert.ok(!EXTENSION_CSP.includes("allow-same-origin"));

console.log("studio-extension: ok");
