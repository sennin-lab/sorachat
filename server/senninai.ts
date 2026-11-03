import { Router } from "express";
import { config } from "./config.js";
import { currentUserId, requireAuth } from "./auth.js";
import { decryptText } from "./crypto.js";
import { sendToUser } from "./hub.js";
import { BlockedError, COLUMNS, broadcastList, findOrCreateDm, insertMessage, membership, pollDataOf, postNotice, type MessageRow } from "./messages.js";
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
const MAX_MEMBER_CHARS = 300;
const MAX_QUESTION_CHARS = 300;
const MAX_SENT_CHARS = 1000; // 1件あたりの送信量の上限
const MAX_HISTORY_ITEM_CHARS = 300; // 履歴1件の上限
const MAX_HISTORY_CHARS = 1000; // 履歴の合計の上限
const PENDING_MS = 5 * 60_000;
export const PREVIOUS = "__PREVIOUS__";

export const GREETING = [
  "はじめまして、senninai（AIチャット）です。できることは次の通りです。",
  "・このトークに話しかけると、AIが答えます",
  "・「太郎とのチャットを読んで要点を教えて」→ そのトークの内容をもとに答えます",
  "・「太郎への返信を考えて」→ 返信案を3つ出します",
  "・「太郎に『明日遅れます』と送って」→ 送る前に確認の画面を出します",
  "・グループでは「/senninai add」で参加、「/senninai ask 質問」で質問できます（「太郎のことどう思う？」のように人について聞くこともできます）。外すときは「/senninai delete」",
  "",
  "※ 話しかけた内容や読んだトークの内容は、AIの応答のために外部サービス（UserLocal）へ送られます。"
].join("\n");

const BOT_COMMAND = /^\/senninai(\s|$)/i;
const CONFIRM_YES = /^(はい|うん|ok|おk|オーケー|お願い|yes|送信して)$/i;
const CONFIRM_NO = /^(いいえ|いや|やめ|キャンセル|no|取り消し)/i;
const SEND_VERB = /(送ってくれ|送ってほしい|送って欲しい|送ってください|送っといて|送ってや|送って|送信して|伝えて)/;
const READ_RE = /^(.+?)との(?:チャット|トーク|会話|やり取り|メッセージ|履歴|話)(?:の内容|の履歴)?(?:を|の)?\s*([\s\S]*)$/;
const READ_VERBS = /^(?:読んで|読み取って|見て|確認して|チェックして|見てくれ|チェックしてくれ)[、,\s]*/;
const REPLY_RE = /^(.+?)(?:さん|くん|ちゃん)?(?:への|に対する)返信/;
const SEND_RE = /^(.+?)(?:さん|くん|ちゃん)?[にへ]\s*([\s\S]+)$/;
const QUOTED = /^[「『"“'‘]([\s\S]+?)[」』"”'’]/;
const PREVIOUS_RE = /^(?:この|その|さっきの|今の|前の)?(?:内容|メッセージ|文章|文|これ|それ)$/;
// ルールで読み取れなかった発言のうち、会話の操作に関係しそうなものだけAIに意図を判定させる
const TASK_HINT = /チャット|トーク|会話|やり取り|メッセージ|履歴|送って|送信|伝えて|返信|返事|まとめ|要約|話した|話題|言った|どう思|確認して|チェック|見て/;
const SUMMARY_HINT = /まとめ|要約|話し合|決ま|議論|振り返|やること|ToDo|todo|決定|結論/i;

// ---------- 純粋な解析（テストしやすいように外に出している） ----------

export type GroupCommand = { kind: "add" } | { kind: "delete" } | { kind: "ask"; question: string };

// 「/senninai add」「/senninai ask 質問」を読む。どちらでもなければ null
export function parseGroupCommand(text: string): GroupCommand | null {
  const match = text.trim().match(/^\/senninai(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (/^(add|参加)$/i.test(rest)) return { kind: "add" };
  if (/^(delete|削除)$/i.test(rest)) return { kind: "delete" };
  const ask = rest.match(/^ask(?:\s+([\s\S]*))?$/i);
  if (ask) return { kind: "ask", question: (ask[1] ?? "").trim() };
  return null;
}

export type DmIntent =
  | { kind: "send"; target: string; body: string }
  | { kind: "read"; target: string; question: string }
  | { kind: "reply"; target: string }
  | { kind: "chat" };

// トークでの話しかけを、決まった言い回しから読む。
// 例: 「太郎に『明日遅れます』と送って」「太郎とのチャットを読んで要点を教えて」「太郎への返信を考えて」
export function parseDmIntent(text: string): DmIntent {
  const trimmed = text.trim();
  const read = trimmed.match(READ_RE);
  if (read && read[1].trim()) {
    const question = read[2].replace(/^[、,\s]*/, "").replace(READ_VERBS, "").trim();
    return { kind: "read", target: read[1].trim(), question: question || "要点をまとめてください" };
  }
  const reply = trimmed.match(REPLY_RE);
  if (reply && reply[1].trim()) return { kind: "reply", target: reply[1].trim() };
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

// ルールで読めなかった発言が、AIに意図を判定させる価値のあるものか
export const looksLikeTask = (text: string) => TASK_HINT.test(text);

// AIの判定結果（JSON）を読む。形が正しくなければ null（その場合はふつうの会話として扱う）
export function parseClassifierJson(raw: string): DmIntent | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let data: any;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  switch (data?.action) {
    case "read": {
      const target = text(data.target);
      if (!target) return null;
      return { kind: "read", target, question: text(data.question).slice(0, MAX_QUESTION_CHARS) || "要点をまとめてください" };
    }
    case "reply": {
      const target = text(data.target);
      return target ? { kind: "reply", target } : null;
    }
    case "send": {
      const target = text(data.target);
      const body = text(data.body);
      return target && body ? { kind: "send", target, body } : null;
    }
    case "chat":
      return { kind: "chat" };
    default:
      return null;
  }
}

// 表記のゆれ（全角・大文字小文字・空白・敬称）を吸収して名前を比べる
export const normalizeName = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/(さん|くん|ちゃん|様)$/u, "");

// 質問文の中に名前が出てくるグループのメンバー（人について聞かれているかの判定に使う）
export function mentionedMembers(question: string, members: { id: string; name: string }[]): { id: string; name: string }[] {
  const q = normalizeName(question);
  return members.filter((m) => {
    const n = normalizeName(m.name);
    return n.length >= 2 && q.includes(n);
  }).slice(0, 2);
}

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
  if (!command) return "使い方: /senninai add（グループに参加）／ /senninai ask 質問（AIに質問）／ /senninai delete（グループから外す）";
  if (command.kind === "add") return conv.botMember ? "senninaiはすでにこのグループにいます。" : null;
  if (command.kind === "delete") return conv.botMember ? null : "senninaiはこのグループにいません。";
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

// AI機能をオフにしたとき：確認待ちを消し、一覧を取り直させる（senninaiは一覧から消える）
export async function disableAi(userId: string): Promise<void> {
  const { error } = await sb.from("sc_senninai_pending").delete().eq("user_id", userId);
  if (error) throw error;
  sendToUser(userId, { type: "list" });
}

// UserLocal（senninai API）に問い合わせる。messages は直近の会話（履歴は5件まで）
export async function askAi(messages: { role: "user" | "assistant"; content: string }[], maxChars = MAX_REPLY): Promise<string> {
  // API仕様：履歴は直近5件まで、content は文字列、先頭は user にそろえる（AIの案内文から始まると受け付けない場合がある）
  // 送る量も抑える（仕様書に上限の記載はないため、長い会話で 400 になるのを防ぐ）
  const recent = messages.slice(-5).filter((m) => typeof m.content === "string" && m.content.length > 0);
  const start = recent.findIndex((m) => m.role === "user");
  const sent = (start === -1 ? recent : recent.slice(start)).map((m) => ({ ...m, content: m.content.slice(0, MAX_SENT_CHARS) }));
  let response: Response;
  try {
    response = await postToAi(sent);
  } catch (error) {
    // 通信の一時的な失敗は、もう一度だけ試す
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await postToAi(sent).catch(() => {
      throw error;
    });
  }
  if (response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await postToAi(sent);
  }
  const raw = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!response.ok || data?.error) {
    throw new Error(`senninai API がエラーを返しました（HTTP ${response.status}）: ${raw.slice(0, 200)}`);
  }
  // 応答の形（OpenAI互換・answer・text など）のどれでも回答を読む
  const answer = (data ? pickAnswer(data) : raw).trim();
  if (!answer) throw new Error(`senninai API の回答を読めませんでした: ${raw.slice(0, 200)}`);
  return answer.length > maxChars ? `${answer.slice(0, maxChars)}…` : answer;
}

function postToAi(messages: { role: "user" | "assistant"; content: string }[]) {
  return fetch(`${config.senninAi.baseUrl}/api/chat`, {
    method: "POST",
    // User-Agent がないリクエストは Cloudflare に弾かれることがあるので、ブラウザ相当の見た目にする
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; SoraChat/1.0)"
    },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(30_000)
  });
}

// 応答 JSON から本文を探す。見つからなければ空文字
function pickAnswer(data: any): string {
  const candidates: unknown[] = [
    data?.choices?.[0]?.message?.content,
    data?.choices?.[0]?.text,
    data?.message?.content,
    data?.message,
    data?.answer,
    data?.response,
    data?.result,
    data?.output,
    data?.content,
    data?.text
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
    // コンテンツが部品の配列（[{type:"text", text:"…"}]）で返る形
    if (Array.isArray(value)) {
      const joined = value
        .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

async function say(conversationId: string, body: string, replyToId: string | null = null) {
  const text = body.slice(0, 1000);
  await insertMessage(conversationId, BOT_ID, { kind: "text", body: text }, text, { replyToId });
}

function textOf(row: MessageRow): string | null {
  if (row.deleted_at) return null;
  if (row.kind === "text" || row.kind === "system") return decryptText(row.body) ?? "";
  if (row.kind === "image") return "[写真]";
  if (row.kind === "file") return `[ファイル: ${row.file_name ?? "ファイル"}]`;
  if (row.kind === "poll") return `[投票: ${(pollDataOf(row)?.question ?? "")}]`;
  if (row.kind === "game") return "[ミニゲーム]";
  if (row.kind === "call") return "[通話]";
  return "[連絡先]";
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });

// 会話の直近のメッセージを「時刻 名前: 本文」の行にする
async function loadLines(conversationId: string, limit: number, before?: string, senderId?: string): Promise<string[]> {
  let query = sb.from("sc_messages").select(COLUMNS).eq("conversation_id", conversationId);
  if (before) query = query.lt("created_at", before);
  if (senderId) query = query.eq("sender_id", senderId).eq("kind", "text").is("deleted_at", null);
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
    lines.push(`${clock(row.created_at)} ${name}: ${text.slice(0, 300)}`);
  }
  return lines;
}

// グループのメンバー（senninai以外）
async function groupMembers(conversationId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await sb.from("sc_members").select("user_id").eq("conversation_id", conversationId);
  if (error) throw error;
  const ids = ((data ?? []) as { user_id: string }[]).map((m) => m.user_id).filter((id) => id !== BOT_ID);
  if (!ids.length) return [];
  const { data: users, error: usersError } = await sb.from("sc_users").select("id, display_name").in("id", ids);
  if (usersError) throw usersError;
  return ((users ?? []) as { id: string; display_name: string }[]).map((u) => ({ id: u.id, name: u.display_name }));
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

// ---------- 確認待ちの送信（DBに保存する。モーダルと「はい」「いいえ」の両方で使う） ----------

type Recipient = { label: string; targetConversationId: string | null; friendId: string | null };
type PendingPayload = {
  summary: string;
  label: string;
  targetConversationId: string | null;
  friendId: string | null;
  body: string;
  // 複数の相手（「全員に…」）のとき。なければ上の単独の相手を使う（古い確認待ちとの互換）
  recipients?: Recipient[];
};

async function savePending(userId: string, botDm: string, payload: PendingPayload) {
  const { error } = await sb.from("sc_senninai_pending").upsert(
    { user_id: userId, conversation_id: botDm, payload, expires_at: new Date(Date.now() + PENDING_MS).toISOString() },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

// 確認待ちを取り出して消す（期限切れなら消すだけ）
async function takePending(userId: string): Promise<{ botDm: string; payload: PendingPayload } | null> {
  const { data, error } = await sb.from("sc_senninai_pending").select("conversation_id, payload, expires_at").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { error: deleteError } = await sb.from("sc_senninai_pending").delete().eq("user_id", userId);
  if (deleteError) throw deleteError;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;
  return { botDm: data.conversation_id as string, payload: data.payload as PendingPayload };
}

async function peekPending(userId: string): Promise<PendingPayload | null> {
  const { data, error } = await sb.from("sc_senninai_pending").select("payload, expires_at").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data || new Date(data.expires_at as string).getTime() < Date.now()) return null;
  return data.payload as PendingPayload;
}

// モーダルの「はい」「いいえ」から呼ぶ。結果はトークに届く（送信・取りやめの案内）
export async function answerPending(userId: string, yes: boolean): Promise<"sent" | "cancelled" | "none"> {
  const pending = await takePending(userId);
  if (!pending) return "none";
  if (!yes) {
    await say(pending.botDm, "送信を取りやめました。");
    return "cancelled";
  }
  await runSend(pending.botDm, userId, pending.payload);
  return "sent";
}

// ---------- AIによる意図の判定 ----------

async function classifyIntent(userId: string, text: string): Promise<DmIntent> {
  const names = (await listTargets(userId)).map((t) => t.label).slice(0, 30);
  const prompt = [
    "あなたはチャットアプリのAI「senninai」の意図判定です。次の発言が何をしてほしいかを判定し、JSONだけを1行で出力してください。説明は不要です。",
    '- "read": 会話（トーク・グループ）の内容を確認・要約・質問したい。target=相手またはグループの名前、question=知りたいこと',
    '- "reply": 相手への返信案がほしい。target=相手の名前',
    '- "send": 誰かにメッセージを送ってほしい。target=相手の名前、body=送る本文',
    '- "chat": それ以外（ふつうの質問・雑談）',
    `名前の候補: ${names.join("、") || "なし"}`,
    `発言: ${text}`,
    '出力例: {"action":"read","target":"太郎","question":"何を話したか"}'
  ].join("\n");
  const raw = await askAi([{ role: "user", content: prompt }]);
  return parseClassifierJson(raw) ?? { kind: "chat" };
}

// ---------- 実際の動き ----------

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
      if (command.kind === "delete") {
        if (!conv.botMember) return;
        await removeBotFromGroup(conversationId, userId);
        return;
      }
      if (!conv.botMember || !command.question) return;
      await answerInGroup(conversationId, userId, command.question, row);
      return;
    }
    if (conv.botMember) await handleDm(conversationId, userId, body, row);
  } catch (error) {
    console.error("senninai:", error, (error as any)?.cause ?? "");
    // 原因の手がかり（HTTPステータスや通信エラーのコード）を添える。原因の特定が済んだら外してよい
    const reason = failureReason(error);
    await say(conversationId, `AIが応答できませんでした。時間をおいてもう一度お試しください。${reason ? `\n（原因: ${reason}）` : ""}`, row.id).catch(() => undefined);
  }
}

// グループからsenninaiを外す（グループのメンバーなら誰でもできる）。外したことはお知らせとして残す
async function removeBotFromGroup(conversationId: string, actorId: string): Promise<void> {
  const { error } = await sb.from("sc_members").delete().eq("conversation_id", conversationId).eq("user_id", BOT_ID);
  if (error) throw error;
  await broadcastList(conversationId);
  await postNotice(conversationId, actorId, "senninaiがグループから削除されました（「/senninai add」で再び参加できます）");
}

function failureReason(error: unknown): string {
  const e: any = error;
  const code = e?.cause?.code ?? e?.code ?? (e?.name !== "Error" ? e?.name : "");
  const message = String(e?.message ?? "").replace(/\s+/g, " ").slice(0, 160);
  return [code, message].filter(Boolean).join(" / ");
}

// グループでの質問。要約系の質問は広めに、人について聞かれたらその人の発言も添える
async function answerInGroup(conversationId: string, userId: string, question: string, row: MessageRow) {
  const asker = await askerName(userId);
  const wide = SUMMARY_HINT.test(question);
  const lines = fitTranscript(await loadLines(conversationId, wide ? 40 : 15, row.created_at), MAX_CONTEXT_CHARS);
  const context = lines.length ? lines.join("\n") : "（まだメッセージはありません）";

  const members = await groupMembers(conversationId);
  const mentioned = mentionedMembers(question, members);
  let memberSection = "";
  for (const member of mentioned) {
    const memberLines = fitTranscript(await loadLines(conversationId, 25, row.created_at, member.id), MAX_MEMBER_CHARS);
    if (memberLines.length) memberSection += `\n---\n${member.name}さんの発言（直近）:\n${memberLines.join("\n")}`;
  }
  const guard = mentioned.length
    ? "\n※人についての質問です。上の発言の内容だけを根拠に、中立に短く答えてください。推測で断定したり、個人攻撃はしないでください。"
    : "";
  const prompt = `${PERSONA}\n\n以下はグループチャットの直近のやり取りです。\n---\n${context}${memberSection}\n---\n${asker}さんからの質問: ${question.slice(0, MAX_QUESTION_CHARS)}${guard}`;
  const answer = await askAi([{ role: "user", content: prompt }]);
  await say(conversationId, answer, row.id);
}

async function askerName(userId: string): Promise<string> {
  const { data } = await sb.from("sc_users").select("display_name").eq("id", userId).maybeSingle();
  return (data?.display_name as string | undefined) ?? "メンバー";
}

async function handleDm(conversationId: string, userId: string, body: string, row: MessageRow) {
  if (!(await aiEnabledFor(userId))) return;
  const text = body.trim();

  // 確認待ちの送信があれば、はい／いいえを先に見る（それ以外の発言は確認を取り消して普通に扱う）
  const waiting = await takePending(userId);
  if (waiting) {
    if (CONFIRM_YES.test(text)) return runSend(conversationId, userId, waiting.payload);
    if (CONFIRM_NO.test(text)) return say(conversationId, "送信を取りやめました。");
  }

  let intent = parseDmIntent(text);
  if (intent.kind === "chat" && looksLikeTask(text)) {
    // 言い回しがルールに当たらないときは、AIに「何をしてほしいか」を判定させる（失敗したらふつうの会話）
    intent = await classifyIntent(userId, text).catch((error) => {
      console.error("senninai classify:", error);
      return { kind: "chat" } as DmIntent;
    });
  }
  if (intent.kind === "send") return handleSendRequest(conversationId, userId, intent, row);
  if (intent.kind === "read") return handleRead(conversationId, userId, intent);
  if (intent.kind === "reply") return handleReply(conversationId, userId, intent.target);
  return handleChat(conversationId, text, row);
}

const ALL_TARGETS = ["全員", "みんな", "みなさん", "皆さん"];

async function handleSendRequest(conversationId: string, userId: string, intent: { target: string; body: string }, row: MessageRow) {
  let body = intent.body;
  if (body === PREVIOUS) {
    body = (await previousUserText(conversationId, userId, row.created_at)) ?? "";
    if (!body) return say(conversationId, "送る内容が見つかりませんでした。先に送る文章をこのトークに送ってから、もう一度お願いします。");
  }
  if (!body) return say(conversationId, "何を送るか書いてください。例: 太郎に『明日遅れます』と送って");
  if (body.length > 1000) return say(conversationId, "メッセージは1000文字以内にしてください。");

  const targets = await listTargets(userId);
  let recipients: Recipient[];
  let label: string;
  if (ALL_TARGETS.includes(normalizeName(intent.target))) {
    // 「全員に…」：トークのある相手・グループ全員に送る（確認の画面で名前を全部出す）
    const all = targets.filter((t) => t.conversationId || t.friendId);
    if (!all.length) return say(conversationId, "送る相手がまだいません。");
    recipients = all.map((t) => ({ label: t.label, targetConversationId: t.conversationId, friendId: t.friendId }));
    label = `全員（${all.length}人）`;
  } else {
    const matches = matchTargets(targets, intent.target);
    if (matches.length === 0) {
      return say(conversationId, `「${intent.target}」というトーク相手・グループは見つかりませんでした。名前を確かめてもう一度お願いします。`);
    }
    if (matches.length > 1) {
      const names = matches.map((t) => t.label).join("、");
      return say(conversationId, `候補が複数あります（${names}）。もう一度、正しい名前で指定してください。「全員に…」で全員に送ることもできます。`);
    }
    const target = matches[0];
    recipients = [{ label: target.label, targetConversationId: target.conversationId, friendId: target.friendId }];
    label = target.label;
  }
  const summary = recipients.length > 1
    ? `「${body}」を次の${recipients.length}人に送信します（${recipients.map((r) => r.label).join("、")}）。よろしいですか？`
    : `「${body}」を${label}に送信します。よろしいですか？`;
  const first = recipients[0];
  await savePending(userId, conversationId, {
    summary,
    label,
    targetConversationId: first.targetConversationId,
    friendId: first.friendId,
    body,
    recipients
  });
  return say(conversationId, `${summary}（はい／いいえ）`);
}

const SEND_REASON: Record<string, string> = {
  "not-friend": "友だちではなくなっています",
  "no-talk": "トークが見つかりません",
  blocked: "ブロックされているため送れません"
};

// 1人に送る。送れなかった理由を返す（送れたら "sent"）
async function sendTo(userId: string, body: string, recipient: Recipient): Promise<"sent" | keyof typeof SEND_REASON> {
  let conversation = recipient.targetConversationId;
  if (!conversation && recipient.friendId) {
    // 友だちなら、まだなかったDMを作ってから送る（友だちでなくなっていたら送らない）
    const { data: friend } = await sb.from("sc_friends").select("friend_id").eq("user_id", userId).eq("friend_id", recipient.friendId).maybeSingle();
    if (!friend) return "not-friend";
    conversation = (await findOrCreateDm(userId, recipient.friendId)).id;
  }
  if (!conversation || !(await membership(conversation, userId))) return "no-talk";
  try {
    await insertMessage(conversation, userId, { kind: "text", body }, body);
  } catch (error) {
    if (error instanceof BlockedError) return "blocked";
    throw error;
  }
  return "sent";
}

async function runSend(botDm: string, userId: string, pending: PendingPayload) {
  const recipients: Recipient[] = pending.recipients ?? [
    { label: pending.label, targetConversationId: pending.targetConversationId, friendId: pending.friendId }
  ];
  const sent: string[] = [];
  const failed: string[] = [];
  for (const recipient of recipients) {
    const result = await sendTo(userId, pending.body, recipient);
    if (result === "sent") sent.push(recipient.label);
    else failed.push(`${recipient.label}（${SEND_REASON[result]}）`);
  }
  if (recipients.length === 1) {
    if (sent.length) return say(botDm, `${pending.label}に送信しました。`);
    return say(botDm, `${pending.label}さんには送信しませんでした（${failed[0].replace(/^.*（|）$/g, "")}）。`);
  }
  const lines = [`${sent.length}人に送信しました（${sent.join("、") || "なし"}）。`];
  if (failed.length) lines.push(`送れなかった相手: ${failed.join("、")}`);
  return say(botDm, lines.join("\n"));
}

async function resolveOne(userId: string, conversationId: string, name: string): Promise<Target | null> {
  const matches = matchTargets(await listTargets(userId), name);
  if (matches.length === 0) {
    await say(conversationId, `「${name}」というトーク相手・グループは見つかりませんでした。名前を確かめてもう一度お願いします。`);
    return null;
  }
  if (matches.length > 1) {
    await say(conversationId, `候補が複数あります（${matches.map((t) => t.label).join("、")}）。もう一度、正しい名前で指定してください。`);
    return null;
  }
  return matches[0];
}

async function handleRead(conversationId: string, userId: string, intent: { target: string; question: string }) {
  const target = await resolveOne(userId, conversationId, intent.target);
  if (!target) return;
  if (!target.conversationId) return say(conversationId, `${target.label}さんとのトークはまだありません。`);

  const lines = fitTranscript(await loadLines(target.conversationId, 40), MAX_CONTEXT_CHARS);
  if (!lines.length) return say(conversationId, `「${target.label}」にはまだメッセージがありません。`);
  const question = intent.question.slice(0, MAX_QUESTION_CHARS);
  const prompt = `${PERSONA}\n\n以下は「${target.label}」とのトーク（直近${lines.length}件）です。\n---\n${lines.join("\n")}\n---\n${question}`;
  const answer = await askAi([{ role: "user", content: prompt }]);
  return say(conversationId, `「${target.label}」の直近${lines.length}件をもとに回答します。\n\n${answer}`);
}

async function handleReply(conversationId: string, userId: string, name: string) {
  const target = await resolveOne(userId, conversationId, name);
  if (!target) return;
  if (!target.conversationId) return say(conversationId, `${target.label}さんとのトークはまだないので、返信案を作れません。`);
  const lines = fitTranscript(await loadLines(target.conversationId, 20), 800);
  if (!lines.length) return say(conversationId, `「${target.label}」にはまだメッセージがありません。`);
  const prompt = `${PERSONA}\n\n以下は「${target.label}」とのトークです。\n---\n${lines.join("\n")}\n---\n最後の発言への返信案を、短い文で3つ、番号付きで出してください。`;
  const answer = await askAi([{ role: "user", content: prompt }]);
  return say(conversationId, `「${target.label}」への返信案です。\n\n${answer}`);
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
    .map((m) => ({ role: (m.sender_id === BOT_ID ? "assistant" : "user") as "user" | "assistant", content: (decryptText(m.body) ?? "").slice(0, MAX_HISTORY_ITEM_CHARS) }))
    .filter((m) => m.content);
  // 履歴は合計の文字数も上限まで（古いものから落とす）
  while (history.reduce((sum, m) => sum + m.content.length, 0) > MAX_HISTORY_CHARS && history.length > 1) history.shift();
  const answer = await askAi([...history, { role: "user", content: `${PERSONA}\n\n${text.slice(0, 1000)}` }]);
  return say(conversationId, answer);
}

// ---------- HTTP（確認モーダル用） ----------

export const senninai = Router();
senninai.use("/senninai", requireAuth);

// 確認待ちの送信があれば、その内容（モーダルに出す文）を返す
senninai.get("/senninai/pending", async (_req, res) => {
  const pending = await peekPending(currentUserId(res));
  res.json({ pending: pending ? { summary: pending.summary } : null });
});

senninai.post("/senninai/pending", async (req, res) => {
  const me = currentUserId(res);
  const answer = req.body?.answer;
  if (answer !== "yes" && answer !== "no") {
    res.status(400).json({ error: "はい／いいえで答えてください。" });
    return;
  }
  if (!(await aiEnabledFor(me))) {
    res.status(403).json({ error: AI_OFF_MESSAGE });
    return;
  }
  const result = await answerPending(me, answer === "yes");
  if (result === "none") {
    res.status(404).json({ error: "確認待ちの送信はありません。" });
    return;
  }
  res.json({ ok: true, result });
});
