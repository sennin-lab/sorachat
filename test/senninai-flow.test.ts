import "./env.ts";
// 実際の senninai.ts / messages.ts を、メモリ上の簡易Supabase（テスト用の偽物）につないで流れを確かめる。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sb } from "../server/supabase.ts";
import { encryptText, decryptText } from "../server/crypto.ts";
import { BOT_ID, aiEnabledFor, enableAi, senninaiAfterMessage, senninaiPrecheck } from "../server/senninai.ts";
import { insertMessage, findOrCreateDm, COLUMNS } from "../server/messages.ts";

// ---------- メモリ上のテーブル ----------
type Row = Record<string, any>;
const tables: Record<string, Row[]> = {
  sc_users: [],
  sc_members: [],
  sc_conversations: [],
  sc_messages: [],
  sc_friends: [],
  sc_push_subscriptions: []
};

let clock = 0;

function run(table: string, op: string, filters: ((r: Row) => boolean)[], payload: any, opts: any) {
  const rows = tables[table] ?? (tables[table] = []);
  const matched = rows.filter((r) => filters.every((f) => f(r)));
  if (op === "insert" || op === "upsert") {
    const list = Array.isArray(payload) ? payload : [payload];
    const inserted: Row[] = [];
    for (const item of list) {
      const dup = op === "upsert" && opts?.onConflict
        ? rows.find((r) => opts.onConflict.split(",").every((c: string) => r[c] === item[c]))
        : undefined;
      if (dup) {
        if (opts?.ignoreDuplicates) continue;
        Object.assign(dup, item);
        inserted.push(dup);
        continue;
      }
      // 同じミリ秒にならないよう、作成時刻は必ず単調増加させる（本物のDBの順序に近づける）
      const at = new Date(Date.parse("2026-11-01T00:00:00.000Z") + ++clock).toISOString();
      const row = { id: randomUUID(), joined_at: at, role: "member", ...item, created_at: at };
      rows.push(row);
      inserted.push(row);
    }
    return { data: inserted, error: null };
  }
  if (op === "update") {
    for (const r of matched) Object.assign(r, payload);
    return { data: matched, error: null };
  }
  if (op === "delete") {
    for (const r of matched) rows.splice(rows.indexOf(r), 1);
    return { data: matched, error: null };
  }
  return { data: matched, error: null };
}

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op = "select";
  let payload: any = null;
  let opts: any = null;
  let order: { col: string; asc: boolean } | null = null;
  let limit: number | null = null;
  let mode: "list" | "maybe" | "single" = "list";
  const api: any = {
    select() { return api; },
    eq(col: string, v: any) { filters.push((r) => r[col] === v); return api; },
    in(col: string, vs: any[]) { filters.push((r) => vs.includes(r[col])); return api; },
    lt(col: string, v: any) { filters.push((r) => r[col] < v); return api; },
    is(col: string, v: any) { filters.push((r) => (r[col] ?? null) === v); return api; },
    match(obj: Row) { for (const k of Object.keys(obj)) filters.push((r) => r[k] === obj[k]); return api; },
    order(col: string, o?: { ascending?: boolean }) { order = { col, asc: o?.ascending ?? true }; return api; },
    limit(n: number) { limit = n; return api; },
    insert(p: any) { op = "insert"; payload = p; return api; },
    upsert(p: any, o?: any) { op = "upsert"; payload = p; opts = o; return api; },
    update(p: any) { op = "update"; payload = p; return api; },
    delete() { op = "delete"; return api; },
    maybeSingle() { mode = "maybe"; return api; },
    single() { mode = "single"; return api; },
    then(resolve: any, reject: any) {
      try {
        let result = run(table, op, filters, payload, opts);
        if (op === "select" || result.data) {
          let rows: Row[] = [...(result.data as Row[])];
          if (order) {
            const o = order as { col: string; asc: boolean };
            rows = rows.sort((a, b) => (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0) * (o.asc ? 1 : -1));
          }
          if (limit !== null) rows = rows.slice(0, limit);
          if (mode === "maybe" || mode === "single") return resolve({ data: rows[0] ?? null, error: null });
          return resolve({ data: rows, error: null });
        }
        return resolve(result);
      } catch (e) {
        return reject(e);
      }
    }
  };
  return api;
}

(sb as any).from = (table: string) => builder(table);
(sb as any).rpc = async (name: string, args: { p_user: string }) => {
  assert.equal(name, "sc_list_conversations");
  const me = args.p_user;
  const out: Row[] = [];
  for (const m of tables.sc_members.filter((x) => x.user_id === me)) {
    const c = tables.sc_conversations.find((x) => x.id === m.conversation_id)!;
    const others = tables.sc_members.filter((x) => x.conversation_id === c.id && x.user_id !== me);
    const other = c.is_group ? undefined : tables.sc_users.find((u) => u.id === others[0]?.user_id);
    out.push({
      conversation_id: c.id,
      is_group: c.is_group === true,
      name: c.is_group ? c.title : other?.display_name ?? null,
      other_id: other?.id ?? null,
      other_username: other?.username ?? null,
      last_message_at: c.last_message_at ?? c.created_at,
      last_preview: c.last_preview ?? null,
      last_sender_id: c.last_sender_id ?? null,
      unread: 0,
      my_role: m.role,
      member_count: tables.sc_members.filter((x) => x.conversation_id === c.id).length
    });
  }
  return { data: out, error: null };
};

// ---------- AI（UserLocal）の代わり ----------
const aiCalls: { messages: { role: string; content: string }[] }[] = [];
let aiAnswer = "AIの回答です";
(globalThis as any).fetch = async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  aiCalls.push(body);
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: aiAnswer } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

// ---------- 登場人物 ----------
const ME = randomUUID();
const BOB = randomUUID();
const CAROL = randomUUID();
tables.sc_users.push(
  { id: ME, username: "alice", display_name: "アリス", ai_enabled: false, notify_dm: false },
  { id: BOB, username: "bob", display_name: "太郎", ai_enabled: false, notify_dm: false },
  { id: CAROL, username: "carol", display_name: "キャロル", ai_enabled: false, notify_dm: false },
  { id: BOT_ID, username: "senninai", display_name: "senninai", ai_enabled: false, notify_dm: false, is_bot: true }
);
for (const f of [[ME, BOB], [BOB, ME], [ME, CAROL], [CAROL, ME]]) {
  tables.sc_friends.push({ user_id: f[0], friend_id: f[1] });
}

// 既存のグループ「チーム」（アリス・太郎）と、会議の話
const GROUP = randomUUID();
tables.sc_conversations.push({ id: GROUP, is_group: true, title: "チーム", created_at: new Date().toISOString() });
tables.sc_members.push({ conversation_id: GROUP, user_id: ME, role: "owner" }, { conversation_id: GROUP, user_id: BOB, role: "member" });
tables.sc_messages.push({
  id: randomUUID(), conversation_id: GROUP, sender_id: BOB, kind: "text", body: encryptText("明日の会議は14時です"),
  created_at: "2026-10-31T09:00:00.000Z", deleted_at: null, client_id: null
});

// 太郎（BOB）との既存の1対1トーク
const BOB_DM = randomUUID();
tables.sc_conversations.push({ id: BOB_DM, is_group: false, created_at: new Date().toISOString() });
tables.sc_members.push({ conversation_id: BOB_DM, user_id: ME }, { conversation_id: BOB_DM, user_id: BOB });

const texts = (conv: string) =>
  tables.sc_messages.filter((m) => m.conversation_id === conv).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((m) => ({
    from: m.sender_id === BOT_ID ? "BOT" : m.sender_id === ME ? "ME" : m.sender_id === BOB ? "BOB" : m.sender_id === CAROL ? "CAROL" : "?",
    body: m.deleted_at ? null : decryptText(m.body)
  }));
const lastBot = (conv: string) => texts(conv).filter((m) => m.from === "BOT").at(-1)?.body ?? null;

// 1つのメッセージを、ルートと同じ順番で流す（precheck → 保存 → 後処理）
async function send(conv: string, from: string, body: string) {
  const problem = await senninaiPrecheck(conv, from, body);
  if (problem) return { rejected: problem };
  const row = await insertMessage(conv, from, { kind: "text", body }, body);
  await senninaiAfterMessage(conv, from, body, row as any);
  return { rejected: null };
}

async function main() {
  // 1) AIオフの間は、senninaiのトークは作られず、話しかけても断られる
  assert.equal(await aiEnabledFor(ME), false);

  // 2) AIをオンにする → senninaiとのトークができ、案内が届く
  tables.sc_users.find((u) => u.id === ME)!.ai_enabled = true;
  await enableAi(ME);
  const botDm = tables.sc_members.find((m) => m.user_id === ME && tables.sc_members.some((x) => x.conversation_id === m.conversation_id && x.user_id === BOT_ID))!.conversation_id;
  assert.ok(botDm, "senninaiとのトークができる");
  assert.match(lastBot(botDm)!, /はじめまして、senninai/);
  // 2回目は作り直さない
  await enableAi(ME);
  assert.equal(tables.sc_members.filter((m) => m.user_id === BOT_ID && m.conversation_id === botDm).length, 1);

  // 3) グループ：参加していないのに ask → 断る（投稿はされない）
  const beforeCount = tables.sc_messages.length;
  const r1 = await send(GROUP, ME, "/senninai ask 明日の会議は何時？");
  assert.match(r1.rejected!, /先に \/senninai add/);
  assert.equal(tables.sc_messages.length, beforeCount, "断ったメッセージは保存されない");

  // 4) グループ：/senninai add → 参加して、案内が出る
  const r2 = await send(GROUP, ME, "/senninai add");
  assert.equal(r2.rejected, null);
  assert.ok(tables.sc_members.some((m) => m.conversation_id === GROUP && m.user_id === BOT_ID), "グループに参加した");
  assert.match(texts(GROUP).at(-1)!.body!, /senninaiが参加しました/);
  // 2回目の add は断る
  assert.match((await send(GROUP, ME, "/senninai add")).rejected!, /すでにこのグループ/);

  // 5) グループ：/senninai ask → 直近の会話を添えてAIに聞き、回答が返る（返信として）
  aiAnswer = "会議は14時です。";
  aiCalls.length = 0;
  const r3 = await send(GROUP, ME, "/senninai ask 明日の会議は何時？");
  assert.equal(r3.rejected, null);
  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].messages[0].content, /明日の会議は14時です/, "直近の会話を文脈として渡す");
  assert.match(aiCalls[0].messages[0].content, /アリスさんからの質問: 明日の会議は何時？/);
  const groupAnswer = tables.sc_messages.filter((m) => m.conversation_id === GROUP && m.sender_id === BOT_ID).at(-1)!;
  assert.equal(decryptText(groupAnswer.body), "会議は14時です。");
  assert.ok(groupAnswer.reply_to_id, "質問への返信として届く");

  // 6) グループ：ふつうの発言には反応しない
  aiCalls.length = 0;
  await send(GROUP, ME, "こんにちは");
  assert.equal(aiCalls.length, 0);

  // 7) senninaiとのトーク：「太郎に…と送って」→ 確認 → はい で送信
  aiCalls.length = 0;
  await send(botDm, ME, "太郎に『明日遅れます』と送って");
  assert.match(lastBot(botDm)!, /「明日遅れます」を太郎に送信します。よろしいですか/);
  const beforeSend = tables.sc_messages.length;
  await send(botDm, ME, "はい");
  assert.match(lastBot(botDm)!, /太郎に送信しました/);
  const sentToBob = tables.sc_messages.slice(beforeSend).find((m) => m.sender_id === ME && decryptText(m.body) === "明日遅れます");
  assert.ok(sentToBob, "本人の名前で、太郎とのトークに送られた");
  assert.equal(sentToBob!.conversation_id, BOB_DM);

  // 8) 確認で「いいえ」なら送らない
  await send(botDm, ME, "太郎に『やっぱりなし』と送って");
  const countBeforeNo = tables.sc_messages.length;
  await send(botDm, ME, "いいえ");
  assert.match(lastBot(botDm)!, /取りやめました/);
  assert.equal(tables.sc_messages.length, countBeforeNo + 2, "「いいえ」の発言と取りやめの案内の2件だけ増える");
  assert.equal(tables.sc_messages.filter((m) => m.conversation_id !== botDm && decryptText(m.body) === "やっぱりなし").length, 0, "送信はされていない");

  // 9) 「この内容を送って」→ 直前に自分が書いた文章を送る（まだトークのないキャロルにもDMを作って送る）
  await send(botDm, ME, "来週の打ち合わせ、よろしくお願いします");
  await send(botDm, ME, "キャロルにこの内容を送ってや");
  assert.match(lastBot(botDm)!, /「来週の打ち合わせ、よろしくお願いします」をキャロルに送信します/);
  await send(botDm, ME, "はい");
  const carolDm = tables.sc_members.find((m) => m.user_id === CAROL && tables.sc_members.some((x) => x.conversation_id === m.conversation_id && x.user_id === ME));
  assert.ok(carolDm, "キャロルとのDMが新しく作られた");
  assert.ok(tables.sc_messages.some((m) => m.conversation_id === carolDm!.conversation_id && decryptText(m.body) === "来週の打ち合わせ、よろしくお願いします"));

  // 10) 名前が見つからない・あいまいなときは送らない
  await send(botDm, ME, "ダレダレに『hi』と送って");
  assert.match(lastBot(botDm)!, /見つかりませんでした/);

  // 11) 「チームとのチャットを読んで会議の時間を教えて」→ グループの内容をもとに回答
  aiCalls.length = 0;
  aiAnswer = "14時です。";
  await send(botDm, ME, "チームとのチャットを読んで会議の時間を教えて");
  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].messages[0].content, /明日の会議は14時です/);
  assert.match(aiCalls[0].messages[0].content, /会議の時間を教えて/);
  assert.match(lastBot(botDm)!, /「チーム」の直近\d+件をもとに回答します。\n\n14時です。/);

  // 12) ふつうの質問はAIへ（直近の履歴を添える）
  aiCalls.length = 0;
  aiAnswer = "東京です。";
  await send(botDm, ME, "日本の首都はどこ？");
  assert.equal(aiCalls.length, 1);
  assert.equal(lastBot(botDm), "東京です。");

  // 13) AIをオフにすると、senninaiへの発言は断られる（送る・読むも同様）
  tables.sc_users.find((u) => u.id === ME)!.ai_enabled = false;
  assert.match((await send(botDm, ME, "こんにちは")).rejected!, /設定でAI機能をオンに/);
  assert.match((await send(GROUP, ME, "/senninai ask 何時？")).rejected!, /設定でAI機能をオンに/);

  // 14) senninai本人の発言では反応しない（無限ループ防止）
  aiCalls.length = 0;
  await senninaiAfterMessage(botDm, BOT_ID, "はい", { id: "x", created_at: new Date().toISOString() } as any);
  assert.equal(aiCalls.length, 0);

  // 15) 友だちでない人（トーク無し）でも名前のコマンドは「候補なし」で止まる
  tables.sc_users.find((u) => u.id === ME)!.ai_enabled = true;
  await send(botDm, ME, "さとうに『hi』と送って");
  assert.match(lastBot(botDm)!, /見つかりませんでした/);

  console.log("flow checks passed");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("FLOW TEST FAILED:", error);
    process.exit(1);
  }
);
