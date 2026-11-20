import "./env.ts";
// ストアの商品検査（スタンプ・変更の検証）と、店舗QRの読み書きの確認。実際のSupabaseには接続しない。
import assert from "node:assert/strict";
import { checkChange, checkStamps, type LineupItem } from "../server/storeLineup.ts";
import { merchantQrValue } from "../server/senninpay.ts";
import { merchantIdFromQr } from "../src/qr.ts";

const pack = { id: "stamp-pack-1", kind: "stamp_pack", name: "a", description: "", price: 100, stamps: [], enabled: true, custom: false } as LineupItem;
const theme = { id: "theme-sakura", kind: "theme", name: "x", description: "", price: 200, enabled: true, custom: false } as LineupItem;

// スタンプ：古い形・ファイル名の形が、日本語の名前に揃い、重複は1つにまとまる
const ok = checkStamps(["builtin:_u304a_u3081_u3067_u3068_u3046.png", "builtin:おめでとう.png"]);
assert.ok(ok.ok);
assert.deepEqual(ok.stamps, ["builtin:おめでとう.png"]);

// 組み込み以外・パス区切り・配列でないものは拒否
assert.equal(checkStamps(["https://example.com/x.png"]).ok, false);
assert.equal(checkStamps(["builtin:../secret.png"]).ok, false);
assert.equal(checkStamps("x").ok, false);

// 変更の検査：価格・名前・スタンプの対象
assert.equal(checkChange(pack, { price: 99999 }).ok, false);
assert.equal(checkChange(pack, { price: 1.5 }).ok, false);
assert.equal(checkChange(pack, { name: "   " }).ok, false);
assert.equal(checkChange(theme, { stamps: ["builtin:ok.png"] }).ok, false);
const good = checkChange(pack, { price: 0, enabled: false, stamps: ["builtin:ok.png"] });
assert.ok(good.ok);
assert.deepEqual(good.value, { price: 0, enabled: false, stamps: ["builtin:ok.png"] });

// 店舗QR：書いたものを読み戻せる。ほかの形のQRは受け付けない
const id = "123e4567-e89b-42d3-a456-426614174000";
assert.equal(merchantIdFromQr(merchantQrValue(id)), id);
assert.equal(merchantIdFromQr("sorachat://user/taro"), null);
assert.equal(merchantIdFromQr("https://example.com"), null);

console.log("pay helper checks passed");
