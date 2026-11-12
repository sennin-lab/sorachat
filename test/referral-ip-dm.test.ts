// 友だち招待・IP の判定・DM の重複防止の確認。実際のSupabaseには接続しない（sb をスタブする）。
import "./env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { sb } = await import("../server/supabase.ts");
const { findOrCreateDm } = await import("../server/messages.ts");
const { checkInvite, recordReferral, retryPendingReferrals, ReferralError } = await import("../server/referral.ts");
const { normalizeIp, manualIp, upgradeIp } = await import("../server/ipBans.ts");

// ---- 最小限の Supabase スタブ（await すると結果が返る。わざと少し遅らせて同時実行の競合を作る）----
const tables: Record<string, any[]> = { sc_members: [], sc_conversations: [], sc_users: [], sc_referrals: [], sc_sennin_tokens: [] };
let inserts = 0;
const wait = () => new Promise((r) => setTimeout(r, 5));

function from(table: string) {
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: any = null;
  let single = false;
  const filters: { col: string; val: any; isIn: boolean }[] = [];
  const match = (row: any) => filters.every((f) => (f.isIn ? f.val.includes(row[f.col]) : row[f.col] === f.val));
  const run = async (): Promise<any> => {
    await wait();
    const rows = tables[table] ?? [];
    if (op === "insert") {
      const list = Array.isArray(payload) ? payload : [payload];
      // DB の既定値を再現する（sc_referrals は pending で作られる）
      const defaults = table === "sc_referrals" ? { inviter_status: "pending", invitee_status: "pending", last_error: null } : {};
      const created = list.map((p) => ({ id: p.id ?? randomUUID(), ...defaults, ...p }));
      rows.push(...created);
      if (table === "sc_conversations") inserts += created.length;
      return { data: single ? created[0] : created, error: null };
    }
    if (op === "update") {
      for (const row of rows.filter(match)) Object.assign(row, payload);
      return { data: null, error: null };
    }
    if (op === "delete") {
      tables[table] = rows.filter((r) => !match(r));
      return { data: null, error: null };
    }
    const data = rows.filter(match).map((r) => structuredClone(r));
    if (single) return { data: data[0] ?? null, error: null };
    return { data, error: null };
  };
  const api: any = {
    select: (_cols?: string, opts?: any) => {
      if (opts?.head) {
        return { eq: (c: string, v: any) => ({ then: (ok: any) => ok({ count: (tables[table] ?? []).filter((r) => r[c] === v).length, error: null }) }) };
      }
      return api;
    },
    eq: (col: string, val: any) => {
      filters.push({ col, val, isIn: false });
      return api;
    },
    in: (col: string, val: any[]) => {
      filters.push({ col, val, isIn: true });
      return api;
    },
    limit: () => api,
    maybeSingle: () => {
      single = true;
      return run();
    },
    single: () => {
      single = true;
      return run();
    },
    insert: (p: any) => {
      op = "insert";
      payload = p;
      return api;
    },
    update: (p: any) => {
      op = "update";
      payload = p;
      return api;
    },
    delete: () => {
      op = "delete";
      return api;
    },
    then: (ok: any, fail: any) => run().then(ok, fail)
  };
  return api;
}
(sb as any).from = from;
(sb as any).rpc = async () => ({ data: null, error: { message: "unused" } });

// ---- 1. 連打（同時の2人のDM作成）で、1対1のトークは1つだけ ----
{
  const a = randomUUID();
  const b = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => findOrCreateDm(a, b)));
  const ids = new Set(results.map((r) => r.id));
  assert.equal(ids.size, 1, "同時に作っても、会話は1つだけになる");
  assert.equal(inserts, 1, "会話の作成は1回だけ");
  assert.equal(results.filter((r) => r.created).length, 1, "作ったのは1回だけ");
  console.log("ok: DMの連打で会話が1つだけできる");
}

// ---- 2. IP の正規化・手入力の検査 ----
{
  assert.equal(normalizeIp("::ffff:203.0.113.10"), "203.0.113.10");
  assert.equal(normalizeIp("203.0.113.10"), "203.0.113.10");
  assert.equal(normalizeIp("2001:DB8::1"), "2001:db8::1");
  assert.equal(normalizeIp("unknown"), null);
  assert.equal(normalizeIp("999.1.1.1"), null);
  // WebSocket の接続要求：X-Forwarded-For の最後の値（プロキシが見た相手）を使う
  assert.equal(upgradeIp({ headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.9" } }), "203.0.113.9");
  assert.equal(upgradeIp({ headers: {}, socket: { remoteAddress: "::ffff:192.0.2.7" } }), "192.0.2.7");
  assert.equal(manualIp(""), null);
  assert.equal(manualIp(12 as unknown), null);
  console.log("ok: IPの正規化・手入力の検査");
}

// ---- 3. 同じ回線からの招待は弾く（招待者の IP・過去の被招待者の IP）----
{
  const inviter = randomUUID();
  tables.sc_users.push({ id: inviter, signup_ip: "198.51.100.1", last_ip: "198.51.100.2", invite_code: "ABCD2345" });
  await assert.rejects(checkInvite(inviter, "198.51.100.1"), ReferralError, "登録時の IP と同じ");
  await assert.rejects(checkInvite(inviter, "198.51.100.2"), ReferralError, "最後のログインの IP と同じ");
  await checkInvite(inviter, "203.0.113.50"); // 別の回線は通る

  await recordReferral(inviter, randomUUID(), null, "203.0.113.50");
  await assert.rejects(checkInvite(inviter, "203.0.113.50"), ReferralError, "過去の被招待者と同じ回線");
  console.log("ok: 同じ回線からの招待は禁止");
}

// ---- 4. 払えない報酬は pending のまま残り、理由が残る（仙人未連携）----
{
  const inviter = randomUUID();
  const invitee = randomUUID();
  tables.sc_users.push({ id: inviter, signup_ip: "192.0.2.1", last_ip: "192.0.2.1" });
  tables.sc_users.push({ id: invitee, signup_ip: "192.0.2.2", last_ip: "192.0.2.2" });
  const referralId = await recordReferral(inviter, invitee, "192.0.2.1", "192.0.2.2");
  // 報酬の付与は裏で行うので、理由が書かれるまで待つ（最大1秒）
  for (let i = 0; i < 100 && !tables.sc_referrals.find((r) => r.id === referralId)?.last_error; i++) await wait();
  const row = tables.sc_referrals.find((r) => r.id === referralId);
  assert.ok(row, "招待の記録がある");
  assert.equal(row.inviter_status, "pending");
  assert.equal(row.invitee_status, "pending");
  assert.ok(row.last_error, "失敗の理由が残る");
  await retryPendingReferrals(invitee);
  assert.equal(tables.sc_referrals.find((r) => r.id === referralId)?.invitee_status, "pending", "未連携のままなら保留");
  console.log("ok: 払えない報酬は保留で残る");
}

console.log("すべて合格");
process.exit(0);
