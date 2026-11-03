import { decryptText, encryptText } from "./crypto.js";
import { normalizeStampRef } from "./stampRef.js";
import { activeEndpoints, sendToUser } from "./hub.js";
import { removeImage } from "./media.js";
import { notifyRecipient } from "./push.js";
import type { GameView } from "./gameLogic.js";
import { sb } from "./supabase.js";

export const UUID = /^[0-9a-f-]{36}$/i;
export const COLUMNS =
  "id, conversation_id, sender_id, kind, body, created_at, edited_at, deleted_at, forwarded, file_name, file_size, contact_user_id, reply_to_id, stamp_ref";

export type Role = "owner" | "member";
export type Reaction = { emoji: string; count: number; mine: boolean };
export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: "text" | "image" | "file" | "contact" | "system" | "stamp" | "poll" | "game";
  body: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  forwarded: boolean;
  file_name: string | null;
  file_size: number | null;
  contact_user_id: string | null;
  reply_to_id: string | null;
  stamp_ref: string | null;
};
export type ContactInfo = { id: string; username: string; displayName: string; hasAvatar: boolean };
export type Content =
  | { kind: "system"; body: string }
  | { kind: "text"; body: string }
  | { kind: "image"; imagePath: string }
  | { kind: "file"; filePath: string; fileName: string; fileSize: number }
  | { kind: "contact"; contactUserId: string }
  | { kind: "stamp"; stampRef: string }
  | { kind: "poll"; question: string; options: string[]; multiple: boolean; anonymous?: boolean }
  | { kind: "game" };

// 投票の中身（body に暗号化して保存する JSON）と、画面に返す形（票数・自分の選択つき）
// closedAt は締め切った時刻（締め切るまでは null）。締め切りも body を書き換えて保存する
export type PollData = { question: string; options: string[]; multiple: boolean; anonymous?: boolean; closedAt?: string | null };
export type PollPerson = { id: string; name: string; hasAvatar: boolean };
export type PollView = {
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
  closedAt: string | null;
  creatorId: string;
  counts: number[];
  mine: number[];
  voters: number;
  // 匿名でないときだけ、選択肢ごとに誰が選んだか（匿名のときは null）
  voterDetails: PollPerson[][] | null;
};
export type PollVote = { user_id: string; option_index: number };

export const pollBodyOf = (poll: PollData) => JSON.stringify(poll);

export function pollDataOf(row: MessageRow): PollData | null {
  if (row.kind !== "poll" || row.deleted_at) return null;
  try {
    const data = JSON.parse(decryptText(row.body ?? "") || "null");
    if (data && typeof data.question === "string" && Array.isArray(data.options)) {
      return {
        question: data.question,
        options: data.options.map(String),
        multiple: Boolean(data.multiple),
        anonymous: Boolean(data.anonymous),
        closedAt: typeof data.closedAt === "string" ? data.closedAt : null
      };
    }
  } catch {
    // 壊れたデータは表示しない
  }
  return null;
}

// 投票した人の名前とアバターの有無（匿名でない投票の一覧に使う）
export async function pollPeople(userIds: string[]): Promise<Map<string, PollPerson>> {
  const people = new Map<string, PollPerson>();
  const unique = [...new Set(userIds)];
  if (!unique.length) return people;
  const { data, error } = await sb.from("sc_users").select("id, display_name, avatar_path").in("id", unique);
  if (error) throw error;
  for (const u of (data ?? []) as { id: string; display_name: string | null; avatar_path: string | null }[]) {
    people.set(u.id, { id: u.id, name: u.display_name ?? "メンバー", hasAvatar: Boolean(u.avatar_path) });
  }
  return people;
}

export function pollView(
  data: PollData,
  votes: PollVote[],
  viewer: string,
  creatorId: string,
  people: Map<string, PollPerson> = new Map()
): PollView {
  const counts = data.options.map(() => 0);
  const mine: number[] = [];
  const voters = new Set<string>();
  for (const v of votes) {
    if (v.option_index >= counts.length) continue;
    counts[v.option_index] += 1;
    voters.add(v.user_id);
    if (v.user_id === viewer) mine.push(v.option_index);
  }
  const anonymous = Boolean(data.anonymous);
  const voterDetails = anonymous
    ? null
    : data.options.map((_, index) =>
        votes
          .filter((v) => v.option_index === index)
          .map((v) => people.get(v.user_id) ?? { id: v.user_id, name: "メンバー", hasAvatar: false })
      );
  return {
    question: data.question,
    options: data.options,
    multiple: data.multiple,
    anonymous,
    closedAt: data.closedAt ?? null,
    creatorId,
    counts,
    mine,
    voters: voters.size,
    voterDetails
  };
}

// スタンプの指定。stamp_ref が空の古い行は本文に名前が入っていることがあるので、そちらも見る
function stampRefOf(row: { stamp_ref: string | null; body: string | null }): string | null {
  const raw = row.stamp_ref ?? (row.body ? decryptText(row.body) : null);
  if (!raw) return null;
  return normalizeStampRef(raw);
}

export function toMessage(
  row: MessageRow,
  reactions: Reaction[] = [],
  clientId: string | null = null,
  contact: ContactInfo | null = null,
  poll: PollView | null = null,
  game: GameView | null = null
) {
  const deleted = row.deleted_at !== null;
  const pollData = row.kind === "poll" ? pollDataOf(row) : null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    // 投票の本文は質問文にする（一覧・返信の表示用）
    // スタンプは本文を持たない（古い行では本文に名前が入っていることがあるので表示しない）
    body: deleted ? null : row.kind === "poll" ? pollData?.question ?? null : row.kind === "stamp" ? null : decryptText(row.body),
    poll: deleted ? null : poll,
    game: deleted ? null : game,
    imageUrl: row.kind === "image" && !deleted ? `/api/dm/messages/${row.id}/image` : null,
    fileName: row.kind === "file" && !deleted ? row.file_name : null,
    fileSize: row.kind === "file" && !deleted ? row.file_size : null,
    fileUrl: row.kind === "file" && !deleted ? `/api/dm/messages/${row.id}/file` : null,
    contact: row.kind === "contact" && !deleted ? contact : null,
    stampRef: row.kind === "stamp" && !deleted ? stampRefOf(row) : null,
    createdAt: row.created_at,
    edited: row.edited_at !== null,
    deleted,
    forwarded: row.forwarded,
    replyToId: row.reply_to_id,
    reactions,
    clientId
  };
}

export async function membership(conversationId: string, userId: string): Promise<{ role: Role } | null> {
  if (!UUID.test(conversationId)) return null;
  const { data, error } = await sb
    .from("sc_members")
    .select("role")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? { role: data.role as Role } : null;
}

export async function memberIds(conversationId: string): Promise<string[]> {
  const { data, error } = await sb.from("sc_members").select("user_id").eq("conversation_id", conversationId);
  if (error) throw error;
  return (data ?? []).map((row: any) => row.user_id as string);
}

// 2人だけの「グループでない」会話を探す。なければ新しく作る（created は新しく作ったかどうか）。
// グループ（is_group = true）は絶対に返さない。旧DMは is_group が null のことがあるので null は1対1扱い。
export async function findOrCreateDm(me: string, other: string): Promise<{ id: string; created: boolean }> {
  const { data: mine, error: mineError } = await sb.from("sc_members").select("conversation_id").eq("user_id", me);
  if (mineError) throw mineError;
  const myIds = (mine ?? []).map((row: { conversation_id: string }) => row.conversation_id);

  if (myIds.length) {
    const { data: shared, error: sharedError } = await sb
      .from("sc_members")
      .select("conversation_id")
      .eq("user_id", other)
      .in("conversation_id", myIds);
    if (sharedError) throw sharedError;
    const sharedIds = (shared ?? []).map((row: { conversation_id: string }) => row.conversation_id);

    if (sharedIds.length) {
      const { data: convs, error: convsError } = await sb
        .from("sc_conversations")
        .select("id, is_group")
        .in("id", sharedIds);
      if (convsError) throw convsError;
      const candidates = (convs ?? []).filter((c: { is_group: boolean | null }) => c.is_group !== true).map((c: { id: string }) => c.id);

      if (candidates.length) {
        const { data: members, error: membersError } = await sb
          .from("sc_members")
          .select("conversation_id, user_id")
          .in("conversation_id", candidates);
        if (membersError) throw membersError;
        for (const id of candidates) {
          const people = (members ?? []).filter((m: { conversation_id: string }) => m.conversation_id === id);
          const ids = people.map((m: { user_id: string }) => m.user_id);
          if (ids.length === 2 && ids.includes(me) && ids.includes(other)) return { id, created: false };
        }
      }
    }
  }

  const { data: created, error: createError } = await sb
    .from("sc_conversations")
    .insert({ is_group: false })
    .select("id")
    .single();
  if (createError) throw createError;
  const { error: memberError } = await sb.from("sc_members").insert([
    { conversation_id: created.id, user_id: me },
    { conversation_id: created.id, user_id: other },
  ]);
  if (memberError) throw memberError;
  return { id: created.id as string, created: true };
}

export function summarize(rows: { user_id: string; emoji: string }[], viewer: string): Reaction[] {
  const map = new Map<string, Reaction>();
  for (const r of rows) {
    const entry = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    entry.count += 1;
    if (r.user_id === viewer) entry.mine = true;
    map.set(r.emoji, entry);
  }
  return [...map.values()];
}

// 会話の全メンバーへ同じイベントを送る（オンラインのみ。オフラインはDBに残るので後で取得できる）
export async function broadcastToConversation(conversationId: string, payload: unknown) {
  const members = await memberIds(conversationId);
  for (const uid of members) sendToUser(uid, payload);
}

export async function broadcastList(conversationId: string) {
  await broadcastToConversation(conversationId, { type: "list" });
}

export async function broadcastReactions(conversationId: string, messageId: string) {
  const [members, { data, error }] = await Promise.all([
    memberIds(conversationId),
    sb.from("sc_reactions").select("user_id, emoji").eq("message_id", messageId)
  ]);
  if (error) throw error;
  const rows = (data ?? []) as { user_id: string; emoji: string }[];
  for (const uid of members) {
    sendToUser(uid, { type: "reactions", conversationId, messageId, reactions: summarize(rows, uid) });
  }
}

// 返信先が同じ会話にあるかを確かめる（別の会話のメッセージへの返信は許さない）
export async function replyTargetOk(conversationId: string, replyToId: string | null | undefined): Promise<boolean> {
  if (!replyToId) return true;
  if (!UUID.test(replyToId)) return false;
  const { data, error } = await sb
    .from("sc_messages")
    .select("id")
    .eq("id", replyToId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function notifyOffline(conversationId: string, senderId: string, members: string[], _preview: string, skip: Set<string>) {
  // 送った本人以外の全員へ（通知オフ・ブロックしている人は除く）。画面を開いている端末だけは、その端末への通知を省く
  const others = recipientsToNotify(members, senderId, skip);
  if (!others.length) return;
  const [{ data: sender }, { data: conv }] = await Promise.all([
    sb.from("sc_users").select("display_name").eq("id", senderId).maybeSingle(),
    sb.from("sc_conversations").select("is_group, title").eq("id", conversationId).maybeSingle()
  ]);
  const senderName = conv?.is_group
    ? `${sender?.display_name ?? "メンバー"}（${conv.title ?? "グループ"}）`
    : sender?.display_name ?? "新着メッセージ";
  for (const uid of others) {
    // 本文は通知（Apple/Google のプッシュサービス経由）に載せない
    void notifyRecipient({
      recipientId: uid,
      senderName,
      preview: "新しいメッセージがあります",
      conversationId,
      skipEndpoints: activeEndpoints(uid)
    });
  }
}

// ---------- ブロック・通知オフ・トークの削除 ----------

export class BlockedError extends Error {
  constructor() {
    super("このユーザーとはトークできません。");
    this.name = "BlockedError";
  }
}

// どちらかがもう一方をブロックしているか
export async function blockedBetween(a: string, b: string): Promise<boolean> {
  const { data, error } = await sb
    .from("sc_blocks")
    .select("blocker_id")
    .or(`and(blocker_id.eq.${a},blocked_id.eq.${b}),and(blocker_id.eq.${b},blocked_id.eq.${a})`)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

// 1対1のトークでは、相手とどちらかがブロックしていれば送れない（グループは対象外）
export async function assertNotBlocked(conversationId: string, senderId: string): Promise<void> {
  const { data: conv, error } = await sb.from("sc_conversations").select("is_group").eq("id", conversationId).maybeSingle();
  if (error) throw error;
  if (conv?.is_group === true) return;
  const others = (await memberIds(conversationId)).filter((id) => id !== senderId);
  for (const other of others) {
    if (await blockedBetween(senderId, other)) throw new BlockedError();
  }
}

// 自分がブロックしている人のID
export async function blockedByMe(userId: string): Promise<Set<string>> {
  const { data, error } = await sb.from("sc_blocks").select("blocked_id").eq("blocker_id", userId);
  if (error) throw error;
  return new Set(((data ?? []) as { blocked_id: string }[]).map((r) => r.blocked_id));
}

// その人をブロックしている人のID
export async function blockersOf(userId: string): Promise<Set<string>> {
  const { data, error } = await sb.from("sc_blocks").select("blocker_id").eq("blocked_id", userId);
  if (error) throw error;
  return new Set(((data ?? []) as { blocker_id: string }[]).map((r) => r.blocker_id));
}

// 通知をオフにしているメンバーのID
export async function mutedIds(conversationId: string): Promise<Set<string>> {
  const { data, error } = await sb.from("sc_members").select("user_id").eq("conversation_id", conversationId).eq("muted", true);
  if (error) throw error;
  return new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
}

// 通知を送る相手。送った本人・通知オフ・ブロックしている人を除く
export function recipientsToNotify(members: string[], senderId: string, skip: Set<string>): string[] {
  return members.filter((uid) => uid !== senderId && !skip.has(uid));
}

// 自分のメンバーシップを外す。最後の1人が抜けたら、トークと画像・ファイルを完全に消す
export async function leaveConversation(conversationId: string, userId: string): Promise<void> {
  const { error } = await sb.from("sc_members").delete().eq("conversation_id", conversationId).eq("user_id", userId);
  if (error) throw error;
  const { data, error: remainError } = await sb.from("sc_members").select("user_id").eq("conversation_id", conversationId);
  if (remainError) throw remainError;
  if (!(data ?? []).length) await purgeConversation(conversationId);
  else await broadcastList(conversationId);
}

// トークを完全に消す（メッセージ・リアクション・画像・ファイル・アイコン）
export async function purgeConversation(conversationId: string): Promise<void> {
  const { data: rows, error } = await sb.from("sc_messages").select("image_path, file_path").eq("conversation_id", conversationId);
  if (error) throw error;
  const { data: conv } = await sb.from("sc_conversations").select("avatar_path").eq("id", conversationId).maybeSingle();
  const paths = new Set(
    ((rows ?? []) as { image_path: string | null; file_path: string | null }[])
      .flatMap((r) => [r.image_path, r.file_path])
      .filter((p): p is string => Boolean(p))
  );
  // 先に行を消してから、画像・ファイルがほかの会話（転送先）で使われていなければ消す
  for (const table of ["sc_messages", "sc_members"]) {
    const { error: deleteError } = await sb.from(table).delete().eq("conversation_id", conversationId);
    if (deleteError) throw deleteError;
  }
  const { error: convError } = await sb.from("sc_conversations").delete().eq("id", conversationId);
  if (convError) throw convError;
  for (const path of paths) await removeImageIfUnused(path);
  if (conv?.avatar_path) await removeImage(conv.avatar_path as string);
}

// 送信の流れ: 1) DBに保存 → 2) 会話メンバーのうちオンラインの人へWebSocketで即時配信
// → 3) オフラインの人はDB保存済みの内容をWeb Pushで通知（開いたときにDBから取得）
export async function insertMessage(
  conversationId: string,
  senderId: string,
  content: Content,
  preview: string,
  options: { forwarded?: boolean; clientId?: string | null; replyToId?: string | null } = {}
): Promise<MessageRow> {
  const clientId = options.clientId ?? null;

  // 再送（タイムアウト後のリトライなど）は、既に保存済みのメッセージをそのまま返す
  const findExisting = async () => {
    const { data, error } = await sb
      .from("sc_messages")
      .select(COLUMNS)
      .eq("conversation_id", conversationId)
      .eq("sender_id", senderId)
      .eq("client_id", clientId as string)
      .maybeSingle();
    if (error) throw error;
    return (data as MessageRow | null) ?? null;
  };
  if (clientId) {
    const existing = await findExisting();
    if (existing) return existing;
  }

  // ブロックされている相手とは、1対1のトークで送れない
  await assertNotBlocked(conversationId, senderId);

  const now = new Date().toISOString();
  const shortPreview = preview.slice(0, 80);
  const none = {
    image_path: null,
    file_path: null,
    file_name: null,
    file_size: null,
    contact_user_id: null,
    stamp_ref: null,
    reply_to_id: options.replyToId ?? null
  };
  const fields =
    content.kind === "text"
      ? { ...none, kind: "text", body: encryptText(content.body) }
      : content.kind === "image"
        ? { ...none, kind: "image", body: null, image_path: content.imagePath }
        : content.kind === "file"
          ? { ...none, kind: "file", body: null, file_path: content.filePath, file_name: content.fileName, file_size: content.fileSize }
          : content.kind === "contact"
            ? { ...none, kind: "contact", body: null, contact_user_id: content.contactUserId }
            : content.kind === "stamp"
              ? { ...none, kind: "stamp", body: null, stamp_ref: content.stampRef }
              : content.kind === "poll"
                ? { ...none, kind: "poll", body: encryptText(pollBodyOf(content)) }
                : content.kind === "game"
                  ? { ...none, kind: "game", body: null }
                  : { ...none, kind: "system", body: encryptText(content.body) };

  const { data, error } = await sb
    .from("sc_messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      created_at: now,
      forwarded: options.forwarded ?? false,
      client_id: clientId,
      ...fields
    })
    .select(COLUMNS)
    .single();
  if (error) {
    // 同時に2回届いた場合（一意制約に違反）は、先に保存された方を返す
    if (clientId && (error as { code?: string }).code === "23505") {
      const existing = await findExisting();
      if (existing) return existing;
    }
    throw error;
  }
  const row = data as MessageRow;

  const [members, muted, blockers] = await Promise.all([
    memberIds(conversationId),
    mutedIds(conversationId),
    blockersOf(senderId),
    sb
      .from("sc_conversations")
      .update({ last_message_at: now, last_preview: encryptText(shortPreview), last_sender_id: senderId })
      .eq("id", conversationId),
    sb.from("sc_members").update({ last_read_at: now }).eq("conversation_id", conversationId).eq("user_id", senderId)
  ]);

  // 投票は作った直後なので票はまだ空（自分の選択も空）
  const wirePoll = content.kind === "poll" ? pollView(content, [], senderId, senderId) : null;
  const wire = toMessage(row, [], options.clientId ?? null, null, wirePoll);
  // ブロックした側には、その人の発言を届けない（一覧の更新も送らない）
  const skip = new Set([...muted, ...blockers]);
  for (const uid of members) {
    if (blockers.has(uid)) continue;
    sendToUser(uid, { type: "message", message: wire });
    sendToUser(uid, { type: "list" });
  }
  // 参加・退出などのお知らせは、通知（プッシュ）を送らない
  if (content.kind !== "system") void notifyOffline(conversationId, senderId, members, shortPreview, skip);
  return row;
}

// グループの出来事（参加・退出・削除・名前の変更）をトークに残す。失敗しても本来の操作は止めない
export async function postNotice(conversationId: string, actorId: string, text: string): Promise<void> {
  try {
    await insertMessage(conversationId, actorId, { kind: "system", body: text }, text);
  } catch (error) {
    console.error("notice:", error);
  }
}

// 表示名（お知らせの文に使う）
export async function displayNameOf(userId: string): Promise<string> {
  const { data } = await sb.from("sc_users").select("display_name").eq("id", userId).maybeSingle();
  return (data?.display_name as string | undefined) ?? "メンバー";
}

// 画像・ファイルの実体は、どのメッセージからも参照されなくなったときに消す（転送で共有するため）
export async function removeImageIfUnused(path: string) {
  const { count } = await sb
    .from("sc_messages")
    .select("id", { count: "exact", head: true })
    .or(`image_path.eq.${path},file_path.eq.${path}`);
  if (!count) await removeImage(path);
}
