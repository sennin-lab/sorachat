import { isOnline, sendToUser } from "./hub.js";
import { removeImage } from "./media.js";
import { notifyRecipient } from "./push.js";
import { sb } from "./supabase.js";

export const UUID = /^[0-9a-f-]{36}$/i;
export const COLUMNS = "id, conversation_id, sender_id, kind, body, created_at, edited_at, deleted_at, forwarded, file_name, file_size, contact_user_id";

export type Role = "owner" | "member";
export type Reaction = { emoji: string; count: number; mine: boolean };
export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: "text" | "image" | "file" | "contact";
  body: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  forwarded: boolean;
  file_name: string | null;
  file_size: number | null;
  contact_user_id: string | null;
};
export type ContactInfo = { id: string; username: string; displayName: string; hasAvatar: boolean };
export type Content =
  | { kind: "text"; body: string }
  | { kind: "image"; imagePath: string }
  | { kind: "file"; filePath: string; fileName: string; fileSize: number }
  | { kind: "contact"; contactUserId: string };

export function toMessage(
  row: MessageRow,
  reactions: Reaction[] = [],
  clientId: string | null = null,
  contact: ContactInfo | null = null
) {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: deleted ? null : row.body,
    imageUrl: row.kind === "image" && !deleted ? `/api/dm/messages/${row.id}/image` : null,
    fileName: row.kind === "file" && !deleted ? row.file_name : null,
    fileSize: row.kind === "file" && !deleted ? row.file_size : null,
    fileUrl: row.kind === "file" && !deleted ? `/api/dm/messages/${row.id}/file` : null,
    contact: row.kind === "contact" && !deleted ? contact : null,
    createdAt: row.created_at,
    edited: row.edited_at !== null,
    deleted,
    forwarded: row.forwarded,
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
  options: { forwarded?: boolean; clientId?: string | null } = {}
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

  const now = new Date().toISOString();
  const shortPreview = preview.slice(0, 80);
  const none = { image_path: null, file_path: null, file_name: null, file_size: null, contact_user_id: null };
  const fields =
    content.kind === "text"
      ? { ...none, kind: "text", body: content.body }
      : content.kind === "image"
        ? { ...none, kind: "image", body: null, image_path: content.imagePath }
        : content.kind === "file"
          ? { ...none, kind: "file", body: null, file_path: content.filePath, file_name: content.fileName, file_size: content.fileSize }
          : { ...none, kind: "contact", body: null, contact_user_id: content.contactUserId };

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

// 画像・ファイルの実体は、どのメッセージからも参照されなくなったときに消す（転送で共有するため）
export async function removeImageIfUnused(path: string) {
  const { count } = await sb
    .from("sc_messages")
    .select("id", { count: "exact", head: true })
    .or(`image_path.eq.${path},file_path.eq.${path}`);
  if (!count) await removeImage(path);
}
