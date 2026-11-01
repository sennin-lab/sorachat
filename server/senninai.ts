import { config } from "./config.js";
import { decryptText } from "./crypto.js";
import { COLUMNS, broadcastList, findOrCreateDm, insertMessage, membership, type MessageRow } from "./messages.js";
import { sb } from "./supabase.js";

// senninai（AIチャット）
// sc_users に固定IDのボットとして登録する（schema_v12.sql。パスワードがないのでログインはできない）。
// ボットとのDMと、グループへの参加はふつうの会話・メンバーとして扱うので、送信・一覧・通知の仕組みをそのまま使う。
// AIの回答は UserLocal（SENNIN_AI_URL）に問い合わせる。AIに話しかけた内容は外部サービスへ送られる点に注意。

export const BOT_ID = "5e11a1ab-0000-4000-8000-000000000001";
export const BOT_NAME = "senninai";

const PERSONA = "あなたは「senninai」というチャットアプリのAIです。日本語で、簡潔に答えてください。";
const MAX_REPLY = 900;
const MAX_CONTEXT_CHARS = 1000;
const MAX_QUESTION_CHARS = 300;
const PENDING_MS = 5 * 60_000;
export const PREVIOUS = "__PREVIOUS__";

export const GREETING = [
  "はじめまして、senninai（AIチャット）です。",
  "・このトークに話しかけると、AIが答えます",
  "・「太郎に『明日遅れます』と送って」→ 送る前に確認します",
  "・「太郎とのチャットを読んで要点を教えて」→ そのトークの内容をもとに答えます",
  "・グループでは「/senninai add」で参加、「/senninai ask 質問」で質問できます",
  "",
  "※ 話しかけた内容や読んだトークの内容は、AIの応答のために外部サービス（UserLocal）へ送られます。"
].join("\n");

const BOT_COMMAND = /^\/senninai(\s|$)/i;
const CONFIRM_YES = /^(はい|うん|ok|おk|オーケー|お願い|yes|送信して)$/i;
const CONFIRM_NO = /^(いいえ|いや|やめ|キャンセル|no|取り消し)/i;
const SEND_VERB = /(送ってくれ|送ってほしい|送って欲しい|送ってください|送っといて|送ってや|送って|送信して|伝えて)/;
const READ_RE = /^(.+?)との(?:チャット|トーク|会話|やり取り|メッセージ|履歴)(?:の内容)?(?:を|の)?\s*([\s\S]*)$/;
const SEND_RE = /^(.+?)(?:さん|くん|ちゃん)?[にへ]\s*([\s\S]+)$/;
const QUOTED = /^[「『"“'‘]([\s\S]+?)[」』"”'’]/;
const PREVIOUS_RE = /^(?:この|その|さっきの|今の|前の)?(?:内容|メッセージ|文章|文|これ|それ)$/;

// ---------- 純粋な解析（テストしやすいように外に出している） ----------

export type GroupCommand = { kind: "add" } | { kind: "ask"; question: string };

// 「/senninai add」「/senninai ask 質問」を読む。どちらでもなければ null
export function parseGroupCommand(text: string): GroupCommand | null {
  const match = text.trim().match(/^\/senninai(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (/^(add|参加)$/i.test(rest)) return { kind: "add" };
  const ask = rest.match(/^ask(?:\s+([\s\S]*))?$/i);
  if (ask) return { kind: "ask", question: (ask[1] ?? "").trim() };
  return null;
}

export type DmIntent =
  | { kind: "send"; target: string; body: string }
  | { kind: "read"; target: string; question: string }
  | { kind: "chat" };

// トークでの話しかけを読む。
// 例: 「太郎に『明日遅れます』と送って」「太郎にこの内容を送ってや」「太郎とのチャットを読んで要点を教えて」
export function parseDmIntent(text: string): DmIntent {
  const trimmed = text.trim();
  const read = trimmed.match(READ_RE);
  if (read && read[1].trim()) {
    const question = read[2].replace(/^(?:読んで|読み取って|見て|確認して|チェックして)[、,\s]*/, "").trim();
    return { kind: "read", target: read[1].trim(), question: question || "要点をまとめてください" };
  }
  const send = trimmed.match(SEND_RE);
  if (send && SEND_VERB.test(send[2])) {
    const rest = send[2];
    const content = rest.slice(0, rest.search(SEND_VERB)).trim();
    const quoted = content.match(QUOTED);
    let body = quoted ? quoted[1].trim() : content.replace(/(?:と|って|という|を|で)$/u, "").trim();
    if (!quoted && PREVIOUS_RE.test(body)) body = PREVIOUS;
    return { kind: "send", target: send[1].trim(), body };
  }
  return { kind: "chat" };
}

// 表記のゆれ（全角・大文字小文字・空白・敬称）を吸収して名前を比べる
export const normalizeName = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/(さん|くん|ちゃん|様)$/u, "");

// 新しい順に足していき、上限を超えたら古いものから捨てる（時系列の順で返す）
export function fitTranscript(lines: string[], budget: number): string[] {
  const picked: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const length = lines[i].length + 1;
    if (total + length > budget && picked.length) break;
    picked.unshift(lines[i]);
    total += length;
  }
  return picked;
}

// ---------- DB・AIへの問い合わせ ----------

type ConvInfo = { isGroup: boolean; botMember: boolean };

async function convInfo(conversationId: string): Promise<ConvInfo> {
  const [conv, bot] = await Promise.all([
    sb.from("sc_conversations").select("is_group").eq("id", conversationId).maybeSingle(),
    sb.from("sc_members").select("user_id").eq("conversation_id", conversationId).eq("user_id", BOT_ID).maybeSingle()
  ]);
  if (conv.error) throw conv.error;
  if (bot.error) throw bot.error;
  return { isGroup: conv.data?.is_group === true, botMember: Boolean(bot.data) };
}

export async function aiEnabledFor(userId: string): Promise<boolean> {
  const { data, error } = await sb.from("sc_users").select("ai_enabled").eq("id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data?.ai_enabled);
}

const AI_OFF_MESSAGE = "senninaiを使うには、設定でAI機能をオンにしてください。";

// 送信の前に確かめる。問題があれば理由の文字列を返し、メッセージは保存しない
export async function senninaiPrecheck(conversationId: string, userId: string, body: string): Promise<string | null> {
  const conv = await convInfo(conversationId);
  if (!conv.isGroup) {
    if (conv.botMember && !(await aiEnabledFor(userId))) return AI_OFF_MESSAGE;
    return null;
  }
  if (!BOT_COMMAND.test(body.trim())) return null;
  if (!(await aiEnabledFor(userId))) return AI_OFF_MESSAGE;
  const command = parseGroupCommand(body);
  if (!command) return "使い方: /senninai add（グループに参加）／ /senninai ask 質問（AIに質問）";
  if (command.kind === "add") return conv.botMember ? "senninaiはすでにこのグループにいます。" : null;
  if (!conv.botMember) return "senninaiはまだこのグループにいません。先に /senninai add を送ってください。";
  if (!command.question) return "質問を入力してください。例: /senninai ask 今日の予定は？";
  if (command.question.length > MAX_QUESTION_CHARS) return `質問は${MAX_QUESTION_CHARS}文字以内で入力してください。`;
  return null;
}

// AI機能をオンにしたとき：senninaiとのDMを用意する（一覧に出すため）。新しく作ったときは案内を送る
export async function enableAi(userId: string): Promise<void> {
  const { id, created } = await findOrCreateDm(userId, BOT_ID);
  if (created) await say(id, GREETING);
  await broadcastList(id);
}

// UserLocal（senninai API）に問い合わせる。messages は直近の会話（履歴は5件まで）
export async function askAi(messages: { role: "user" | "assistant"; content: string }[]): Promise<string> {
  const response = await fetch(`${config.senninAi.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(30_000)
  });
  const data = (await response.json().catch(() => ({}))) as any;
  if (!response.ok || data?.error) throw new Error(`senninai API がエラーを返しました（HTTP ${response.status}）`);
  const answer = String(data?.choices?.[0]?.message?.content ?? data?.answer ?? "").trim();
  if (!answer) throw new Error("senninai API の回答が空でした");
  return answer.length > MAX_REPLY ? `${answer.slice(0, MAX_REPLY)}…` : answer;
}

async function say(conversationId: string, body: string, replyToId: string | null = null) {
  const text = body.slice(0, 1000);
  await insertMessage(conversationId, BOT_ID, { kind: "text", body: text }, text, { replyToId });
}

function textOf(row: MessageRow): string | null {
  if (row.deleted_at) return null;
  if (row.kind === "text") return decryptText(row.body) ?? "";
  if (row.kind === "image") return "[写真]";
  if (row.kind === "file") return `[ファイル: ${row.file_name ?? "ファイル"}]`;
  return "[連絡先]";
}

// 会話の直近のメッセージを「名前: 本文」の行にする
async function loadLines(conversationId: string, limit: number, before?: string): Promise<string[]> {
  let query = sb.from("sc_messages").select(COLUMNS).eq("conversation_id", conversationId);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const rows = ((data ?? []) as MessageRow[]).reverse();
  const senders = [...new Set(rows.map((r) => r.sender_id))];
  const names = new Map<string, string>();
  if (senders.length) {
    const { data: users, error: usersError } = await sb.from("sc_users").select("id, display_name").in("id", senders);
    if (usersError) throw usersError;
    for (const u of (users ?? []) as { id: string; display_name: string }[]) names.set(u.id, u.display_name);
  }
  const lines: string[] = [];
  for (const row of rows) {
    const text = textOf(row);
    if (text === null) continue;
    const name = row.sender_id === BOT_ID ? BOT_NAME : names.get(row.sender_id) ?? "メンバー";
    const at = new Date(row.created_at).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
    lines.push(`${at} ${name}: ${text.slice(0, 300)}`);
  }
  return lines;
}

// 直近の自分の文章（「この内容を送って」の「この内容」に使う）
async function previousUserText(conversationId: string, userId: string, before: string): Promise<string | null> {
  const { data, error } = await sb
    .from("sc_messages")
    .select(COLUMNS)
    .eq("conversation_id", conversationId)
    .eq("sender_id", userId)
    .eq("kind", "text")
    .is("deleted_at", null)
    .lt("created_at", before)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as MessageRow[])[0];
  return row ? decryptText(row.body) : null;
}

// ---------- 送信先の名前解決 ----------

type Target = { label: string; conversationId: string | null; friendId: string | null; keys: string[] };

async function listTargets(userId: string): Promise<Target[]> {
  const { data: convs, error } = await sb.rpc("sc_list_conversations", { p_user: userId });
  if (error) throw error;
  const targets: Target[] = [];
  const dmPartners = new Set<string>();
  for (const row of (convs ?? []) as any[]) {
    if (row.other_id === BOT_ID) continue;
    if (!row.is_group && row.other_id) dmPartners.add(row.other_id as string);
    const label = (row.name as string) || (row.other_username as string) || "トーク";
    targets.push({
      label,
      conversationId: row.conversation_id as string,
      friendId: null,
      keys: [row.name, row.other_username].filter((k): k is string => Boolean(k))
    });
  }
  // トークはまだないが友だちの人も対象にする（送るときにDMを作る）
  const { data: friends, error: friendsError } = await sb.from("sc_friends").select("friend_id").eq("user_id", userId);
  if (friendsError) throw friendsError;
  const friendIds = ((friends ?? []) as { friend_id: string }[])
    .map((f) => f.friend_id)
    .filter((id) => id !== BOT_ID && !dmPartners.has(id));
  if (friendIds.length) {
    const { data: users, error: usersError } = await sb.from("sc_users").select("id, username, display_name").in("id", friendIds);
    if (usersError) throw usersError;
    for (const u of (users ?? []) as { id: string; username: string; display_name: string }[]) {
      targets.push({ label: u.display_name, conversationId: null, friendId: u.id, keys: [u.display_name, u.username] });
    }
  }
  return targets;
}

function matchTargets(targets: Target[], name: string): Target[] {
  const query = normalizeName(name);
  if (!query) return [];
  const exact = targets.filter((t) => t.keys.some((k) => normalizeName(k) === query));
  if (exact.length) return exact;
  return targets.filter((t) =>
    t.keys.some((k) => {
      const key = normalizeName(k);
      return key.length >= 2 && (key.includes(query) || query.includes(key));
    })
  );
}

// ---------- 実際の動き ----------

type PendingSend = { target: Target; body: string; expires: number };
const pendingSends = new Map<string, PendingSend>();

export async function senninaiAfterMessage(conversationId: string, userId: string, body: string, row: MessageRow): Promise<void> {
  if (userId === BOT_ID) return;
  try {
    const conv = await convInfo(conversationId);
    if (conv.isGroup) {
      if (!BOT_COMMAND.test(body.trim()) || !(await aiEnabledFor(userId))) return;
      const command = parseGroupCommand(body);
      if (!command) return;
      if (command.kind === "add") {
        if (conv.botMember) return;
        const { error } = await sb
          .from("sc_members")
          .upsert({ conversation_id: conversationId, user_id: BOT_ID, role: "member" }, { onConflict: "conversation_id,user_id", ignoreDuplicates: true });
        if (error) throw error;
        await broadcastList(conversationId);
        await say(conversationId, "senninaiが参加しました。「/senninai ask 質問」で質問できます。");
        return;
      }
      if (!conv.botMember || !command.question) return;
      const asker = await askerName(userId);
      const lines = fitTranscript(await loadLines(conversationId, 15, row.created_at), MAX_CONTEXT_CHARS);
      const context = lines.length ? lines.join("\n") : "（まだメッセージはありません）";
      const prompt = `${PERSONA}\n\n以下はグループチャットの直近のやり取りです。\n---\n${context}\n---\n${asker}さんからの質問: ${command.question}`;
      const answer = await askAi([{ role: "user", content: prompt }]);
      await say(conversationId, answer, row.id);
      return;
    }
    if (conv.botMember) await handleDm(conversationId, userId, body, row);
  } catch (error) {
    console.error("senninai:", error);
    await say(conversationId, "AIが応答できませんでした。時間をおいてもう一度お試しください。", row.id).catch(() => undefined);
  }
}

async function askerName(userId: string): Promise<string> {
  const { data } = await sb.from("sc_users").select("display_name").eq("id", userId).maybeSingle();
  return (data?.display_name as string | undefined) ?? "メンバー";
}

async function handleDm(conversationId: string, userId: string, body: string, row: MessageRow) {
  if (!(await aiEnabledFor(userId))) return;
  const text = body.trim();

  // 送信の確認待ちなら、はい／いいえを先に見る（それ以外の発言は確認を取り消して普通に扱う）
  const waiting = pendingSends.get(userId);
  if (waiting) {
    pendingSends.delete(userId);
    if (waiting.expires > Date.now()) {
      if (CONFIRM_YES.test(text)) return runSend(conversationId, userId, waiting);
      if (CONFIRM_NO.test(text)) return say(conversationId, "送信を取りやめました。");
    }
  }

  const intent = parseDmIntent(text);
  if (intent.kind === "send") return handleSendRequest(conversationId, userId, intent, row);
  if (intent.kind === "read") return handleRead(conversationId, userId, intent);
  return handleChat(conversationId, text, row);
}

async function handleSendRequest(
  conversationId: string,
  userId: string,
  intent: { target: string; body: string },
  row: MessageRow
) {
  let body = intent.body;
  if (body === PREVIOUS) {
    body = (await previousUserText(conversationId, userId, row.created_at)) ?? "";
    if (!body) return say(conversationId, "送る内容が見つかりませんでした。先に送る文章をこのトークに送ってから、もう一度お願いします。");
  }
  if (!body) return say(conversationId, "何を送るか書いてください。例: 太郎に『明日遅れます』と送って");
  if (body.length > 1000) return say(conversationId, "メッセージは1000文字以内にしてください。");

  const matches = matchTargets(await listTargets(userId), intent.target);
  if (matches.length === 0) {
    return say(conversationId, `「${intent.target}」というトーク相手・グループは見つかりませんでした。名前を確かめてもう一度お願いします。`);
  }
  if (matches.length > 1) {
    const names = matches.map((t) => t.label).join("、");
    return say(conversationId, `候補が複数あります（${names}）。もう一度、正しい名前で指定してください。`);
  }
  const target = matches[0];
  pendingSends.set(userId, { target, body, expires: Date.now() + PENDING_MS });
  return say(conversationId, `「${body}」を${target.label}に送信します。よろしいですか？（はい／いいえ）`);
}

async function runSend(conversationId: string, userId: string, pending: PendingSend) {
  const { target, body } = pending;
  let targetConversation = target.conversationId;
  if (!targetConversation && target.friendId) {
    // 友だちなら、まだなかったDMを作ってから送る（友だちでなくなっていたら送らない）
    const { data: friend } = await sb.from("sc_friends").select("friend_id").eq("user_id", userId).eq("friend_id", target.friendId).maybeSingle();
    if (!friend) return say(conversationId, `${target.label}さんとは友だちではなくなっているため、送信しませんでした。`);
    targetConversation = (await findOrCreateDm(userId, target.friendId)).id;
  }
  if (!targetConversation || !(await membership(targetConversation, userId))) {
    return say(conversationId, `${target.label}へのトークが見つからないため、送信しませんでした。`);
  }
  await insertMessage(targetConversation, userId, { kind: "text", body }, body);
  return say(conversationId, `${target.label}に送信しました。`);
}

async function handleRead(conversationId: string, userId: string, intent: { target: string; question: string }) {
  const matches = matchTargets(await listTargets(userId), intent.target);
  if (matches.length === 0) {
    return say(conversationId, `「${intent.target}」というトーク相手・グループは見つかりませんでした。名前を確かめてもう一度お願いします。`);
  }
  if (matches.length > 1) {
    const names = matches.map((t) => t.label).join("、");
    return say(conversationId, `候補が複数あります（${names}）。もう一度、正しい名前で指定してください。`);
  }
  const target = matches[0];
  if (!target.conversationId) return say(conversationId, `${target.label}さんとのトークはまだありません。`);

  const lines = fitTranscript(await loadLines(target.conversationId, 40), MAX_CONTEXT_CHARS);
  if (!lines.length) return say(conversationId, `「${target.label}」にはまだメッセージがありません。`);
  const question = intent.question.slice(0, MAX_QUESTION_CHARS);
  const prompt = `${PERSONA}\n\n以下は「${target.label}」とのトーク（直近${lines.length}件）です。\n---\n${lines.join("\n")}\n---\n${question}`;
  const answer = await askAi([{ role: "user", content: prompt }]);
  return say(conversationId, `「${target.label}」の直近${lines.length}件をもとに回答します。\n\n${answer}`);
}

async function handleChat(conversationId: string, text: string, row: MessageRow) {
  // 直近のやり取り（履歴は5件まで）を添えて答えてもらう
  const { data, error } = await sb
    .from("sc_messages")
    .select(COLUMNS)
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .eq("kind", "text")
    .lt("created_at", row.created_at)
    .order("created_at", { ascending: false })
    .limit(4);
  if (error) throw error;
  const history = ((data ?? []) as MessageRow[])
    .reverse()
    .map((m) => ({ role: (m.sender_id === BOT_ID ? "assistant" : "user") as "user" | "assistant", content: decryptText(m.body) ?? "" }))
    .filter((m) => m.content);
  const answer = await askAi([...history, { role: "user", content: `${PERSONA}\n\n${text.slice(0, 1000)}` }]);
  return say(conversationId, answer);
}
