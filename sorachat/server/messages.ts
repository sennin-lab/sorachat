import { isOnline, sendToUser } from "./hub.js";
import { removeImage } from "./media.js";
import { notifyRecipient } from "./push.js";
import { sb } from "./supabase.js";

export const UUID = /^[0-9a-f-]{36}$/i;
export const COLUMNS = "id, conversation_id, sender_id, kind, body, created_at, edited_at, deleted_at, forwarded, reply_to";

export type Role = "owner" | "member";
export type Reaction = { emoji: string; count: number; mine: boolean };
export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: "text" | "image";
  body: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  forwarded: boolean;
  reply_to: string | null;
};
export type Content = { kind: "text"; body: string } | { kind: "image"; imagePath: string };

export function toMessage(row: MessageRow, reactions: Reaction[] = [], clientId: string | null = null) {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: deleted ? null : row.body,
    imageUrl: row.kind === "image" && !deleted ? `/api/dm/messages/${row.id}/image` : null,
    createdAt: row.created_at,
    edited: row.edited_at !== null,
    deleted,
    forwarded: row.forwarded,
    replyTo: row.reply_to ?? null,
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

async function notifyOffline(conversationId: string, senderId: string, members: string[], preview: string) {
  const offline = members.filter((uid) => uid !== senderId && !isOnline(uid));
  if (!offline.length) return;
  const [{ data: sender }, { data: conv }] = await Promise.all([
    sb.from("sc_users").select("display_name").eq("id", senderId).maybeSingle(),
    sb.from("sc_conversations").select("is_group, title").eq("id", conversationId).maybeSingle()
  ]);
  const senderName = conv?.is_group
    ? `${sender?.display_name ?? "メンバー"}（${conv.title ?? "グループ"}）`
    : sender?.display_name ?? "新着メッセージ";
  for (const uid of offline) {
    void notifyRecipient({ recipientId: uid, senderName, preview, conversationId });
  }
}

// 送信の流れ: 1) DBに保存 → 2) 会話メンバーのうちオンラインの人へWebSocketで即時配信
// → 3) オフラインの人はDB保存済みの内容をWeb Pushで通知（開いたときにDBから取得）
export async function insertMessage(
  conversationId: string,
  senderId: string,
  content: Content,
  preview: string,
  options: { forwarded?: boolean; clientId?: string | null; replyTo?: string | null } = {}
): Promise<MessageRow> {
  const clientId = options.clientId ?? null;

  // 返信先は同じ会話内のメッセージだけ有効にする（別の会話のIDが混ざった場合は通常の送信として扱う）
  let replyTo: string | null = null;
  if (options.replyTo && UUID.test(options.replyTo)) {
    const { data: target } = await sb
      .from("sc_messages")
      .select("id")
      .eq("id", options.replyTo)
      .eq("conversation_id", conversationId)
      .maybeSingle();
    replyTo = target ? (target as { id: string }).id : null;
  }

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

  const now = new Date().toISOString();
  const shortPreview = preview.slice(0, 80);
  const fields =
    content.kind === "text"
      ? { kind: "text", body: content.body, image_path: null }
      : { kind: "image", body: null, image_path: content.imagePath };

  const { data, error } = await sb
    .from("sc_messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      created_at: now,
      forwarded: options.forwarded ?? false,
      reply_to: replyTo,
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

  const [members] = await Promise.all([
    memberIds(conversationId),
    sb
      .from("sc_conversations")
      .update({ last_message_at: now, last_preview: shortPreview, last_sender_id: senderId })
      .eq("id", conversationId),
    sb.from("sc_members").update({ last_read_at: now }).eq("conversation_id", conversationId).eq("user_id", senderId)
  ]);

  const wire = toMessage(row, [], options.clientId ?? null);
  for (const uid of members) {
    sendToUser(uid, { type: "message", message: wire });
    sendToUser(uid, { type: "list" });
  }
  void notifyOffline(conversationId, senderId, members, shortPreview);
  return row;
}

export async function removeImageIfUnused(path: string) {
  const { count } = await sb.from("sc_messages").select("id", { count: "exact", head: true }).eq("image_path", path);
  if (!count) await removeImage(path);
}
