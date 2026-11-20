import "./env.ts";
// SenninPay の送金（支払い側の減算 → 受け取り側の加算 → 失敗時の返金）と、
// 通信結果が分からないときの再送（二重に動かないこと）を確かめる。
// 仙人アカウントの API は fetch をスタブにして、残高をメモリ上で再現する。実際の仙人・Supabase には接続しない。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.SENNIN_BASE_URL = "https://sennin.test";
process.env.SENNIN_CLIENT_ID = "sc-test-client";

const { sb } = await import("../server/supabase.ts");
const { encryptText } = await import("../server/crypto.ts");
const { sendPoints, resumeTransfers } = await import("../server/senninpay.ts");

// ---- メモリ上のテーブル（必要な分だけ） ----
type Row = Record<string, any>;
const tables: Record<string, Row[]> = { sc_sennin_tokens: [], sc_friends: [], sc_merchants: [], sc_pay_transfers: [], sc_users: [] };

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op = "select";
  let payload: any = null;
  let opts: any = null;
  let limit: number | null = null;
  let mode: "list" | "maybe" | "single" = "list";
  const rows = () => (tables[table] ??= []);
  const api: any = {
    select() { return api; },
    eq(col: string, v: any) { filters.push((r) => r[col] === v); return api; },
    in(col: string, vs: any[]) { filters.push((r) => vs.includes(r[col])); return api; },
    or(expr: string) {
      const parsed = expr.split(",").map((c) => { const [col, , val] = c.split("."); return { col, val }; });
      filters.push((r) => parsed.some(({ col, val }) => String(r[col]) === val));
      return api;
    },
    order() { return api; },
    limit(n: number) { limit = n; return api; },
    insert(p: any) { op = "insert"; payload = p; return api; },
    upsert(p: any, o?: any) { op = "upsert"; payload = p; opts = o; return api; },
    update(p: any) { op = "update"; payload = p; return api; },
    maybeSingle() { mode = "maybe"; return api; },
    single() { mode = "single"; return api; },
    then(resolve: any, reject: any) {
      try {
        const matched = rows().filter((r) => filters.every((f) => f(r)));
        if (op === "insert") {
          const row = { created_at: new Date().toISOString(), ...payload };
          rows().push(row);
          return resolve({ data: [row], error: null });
        }
        if (op === "upsert") {
          const key = opts?.onConflict ?? "user_id";
          const found = rows().find((r) => r[key] === payload[key]);
          if (found) Object.assign(found, payload);
          else rows().push({ ...payload });
          return resolve({ data: null, error: null });
        }
        if (op === "update") {
          for (const r of matched) Object.assign(r, payload);
          return resolve({ data: matched, error: null });
        }
        let out = [...matched];
        if (limit !== null) out = out.slice(0, limit);
        if (mode !== "list") return resolve({ data: out[0] ?? null, error: null });
        return resolve({ data: out, error: null });
      } catch (e) {
        return reject(e);
      }
    }
  };
  return api;
}
(sb as any).from = (table: string) => builder(table);

// ---- 仙人アカウントのスタブ（残高・冪等性・失敗の注入）----
const balances = new Map<string, number>();
const applied = new Map<string, { ledgerId: string }>(); // idempotency_key → 結果（再送は同じ結果を返す）
const failures: { user: string; suffix: string; mode: "scope" | "lost" }[] = []; // lost: 処理は行うが応答を失う
let ledgerSeq = 0;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

(globalThis as any).fetch = async (url: string, init: any = {}) => {
  if (url.endsWith("/oauth/token")) {
    const form = new URLSearchParams(String(init.body));
    const user = form.get("refresh_token")!.slice(3);
    return json(200, { access_token: `at-${user}`, refresh_token: `rt-${user}`, expires_in: 3600 });
  }
  if (url.endsWith("/api/v1/points/adjust")) {
    const user = String(init.headers.authorization).slice("Bearer at-".length);
    const body = JSON.parse(init.body);
    const suffix = body.idempotency_key.split("-").slice(-1)[0]; // out / in / refund
    const replayOf = applied.get(body.idempotency_key);
    if (replayOf) return json(200, { ok: true, points: balances.get(user), ledger_id: replayOf.ledgerId, replayed: true });
    const fail = failures.findIndex((f) => f.user === user && f.suffix === suffix);
    if (fail >= 0 && failures[fail].mode === "scope") {
      failures.splice(fail, 1);
      return json(403, { error: "scope" });
    }
    const current = balances.get(user) ?? 0;
    if (current + body.amount < 0) return json(409, { error: "insufficient_points", points: current });
    balances.set(user, current + body.amount);
    const ledgerId = `L${++ledgerSeq}`;
    applied.set(body.idempotency_key, { ledgerId });
    if (fail >= 0 && failures[fail].mode === "lost") {
      failures.splice(fail, 1);
      throw new TypeError("network lost after apply"); // 処理は済んだが、応答は届かなかった
    }
    return json(200, { ok: true, points: balances.get(user), ledger_id: ledgerId, replayed: false });
  }
  throw new Error(`unexpected url ${url}`);
};

// ---- データの準備 ----
const A = randomUUID(); // 支払う人
const B = randomUUID(); // 受け取る人（友だち）
const M = randomUUID(); // 店舗
const C = randomUUID(); // 連携していない人

for (const id of [A, B, M]) {
  tables.sc_sennin_tokens.push({ user_id: id, refresh_token_enc: encryptText(`rt-${id}`) });
  balances.set(id, 0);
}
balances.set(A, 1000);
tables.sc_friends.push({ user_id: A, friend_id: B }, { user_id: B, friend_id: A });
tables.sc_merchants.push({ user_id: M, name: "テスト店", description: "", status: "active" });
const total = () => [...balances.values()].reduce((a, b) => a + b, 0);
const startTotal = total();

// 1) 友だちへの送金が成功する
const t1 = await sendPoints({ me: A, to: B, amount: 300, memo: "", kind: "friend", clientId: "c-1" });
assert.equal(t1.status, "completed");
assert.equal(balances.get(A), 700);
assert.equal(balances.get(B), 300);

// 2) 同じ clientId で再送しても、二重には払わない（同じ送金として返る）
const again = await sendPoints({ me: A, to: B, amount: 300, memo: "", kind: "friend", clientId: "c-1" });
assert.equal(again.id, t1.id);
assert.equal(balances.get(A), 700);
assert.equal(balances.get(B), 300);

// 3) 受け取り側へ渡せないと分かったら返金する（支払い側は元に戻る）
failures.push({ user: B, suffix: "in", mode: "scope" });
await assert.rejects(
  sendPoints({ me: A, to: B, amount: 100, memo: "", kind: "friend", clientId: "c-2" }),
  (e: any) => e.code === "invalid" && /返金しました/.test(e.message)
);
assert.equal(balances.get(A), 700, "返金されて元に戻る");
assert.equal(balances.get(B), 300, "受け取り側は増えない");

// 4) 受け取りの結果が分からない → debited のまま。続きを進めると、二重にはならず完了する
failures.push({ user: B, suffix: "in", mode: "lost" });
await assert.rejects(sendPoints({ me: A, to: B, amount: 50, memo: "", kind: "friend", clientId: "c-3" }));
const pending = tables.sc_pay_transfers.find((r) => r.client_id === "c-3")!;
assert.equal(pending.status, "debited");
assert.equal(balances.get(B), 350, "受け取りは一度だけ行われている（応答だけ失った）");
await resumeTransfers(A);
assert.equal(tables.sc_pay_transfers.find((r) => r.client_id === "c-3")!.status, "completed");
assert.equal(balances.get(B), 350, "続きを進めても二重には増えない");
assert.equal(balances.get(A), 650);

// 5) 支払いの減算の結果が分からない → pending。続きを進めると、一度だけ減って完了する
failures.push({ user: A, suffix: "out", mode: "lost" });
await assert.rejects(sendPoints({ me: A, to: M, amount: 120, memo: "", kind: "qr", clientId: "c-4" }));
assert.equal(balances.get(A), 530, "減算は一度だけ行われている");
await resumeTransfers(A);
const qr = tables.sc_pay_transfers.find((r) => r.client_id === "c-4")!;
assert.equal(qr.status, "completed");
assert.equal(balances.get(M), 120);
assert.equal(balances.get(A), 530, "続きを進めても二重には減らない");

// 6) 店舗が停止中・連携していない相手には払えない（減算より前に断る）
tables.sc_merchants[0].status = "suspended";
await assert.rejects(sendPoints({ me: A, to: M, amount: 10, memo: "", kind: "qr", clientId: "c-5" }), (e: any) => e.code === "invalid");
tables.sc_merchants[0].status = "active";
await assert.rejects(sendPoints({ me: A, to: C, amount: 10, memo: "", kind: "friend", clientId: "c-6" }), (e: any) => e.code === "invalid");
assert.equal(balances.get(A), 530, "断った送金では減らない");

// 7) 残高不足は、受け取り側に触る前に止まる
await assert.rejects(sendPoints({ me: A, to: B, amount: 9999, memo: "", kind: "friend", clientId: "c-7" }), (e: any) => e.code === "invalid" || e.code === "insufficient_points");

// 全体のポイントは増えも減りもしていない（外へ出たのは、受け取った側の残高だけ）
assert.equal(total(), startTotal, "ポイントの合計は変わらない");

console.log("pay transfer checks passed");
process.exit(0);
