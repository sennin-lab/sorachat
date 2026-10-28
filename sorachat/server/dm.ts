import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { isAllowedImage, readImage, saveImage, upload } from "./media.js";
import {
  COLUMNS,
  UUID,
  broadcastList,
  broadcastReactions,
  broadcastToConversation,
  insertMessage,
  membership,
  removeImageIfUnused,
  summarize,
  toMessage,
  type MessageRow
} from "./messages.js";
import { sb } from "./supabase.js";

export const dm = Router();
dm.use("/dm", requireAuth);

const USERNAME = /^[a-z0-9_]{3,20}$/;
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

type Role = "owner" | "member";
type MessageWithPath = MessageRow & { image_path: string | null };

const messageRow = async (messageId: string): Promise<MessageWithPath | null> => {
  const { data, error } = await sb
    .from("sc_messages")
    .select(`${COLUMNS}, image_path`)
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw error;
  return (data as MessageWithPath | null) ?? null;
};

async function withReactions(rows: MessageRow[], viewer: string) {
  if (!rows.length) return [];
  const { data, error } = await sb
    .from("sc_reactions")
    .select("message_id, user_id, emoji")
    .in("message_id", rows.map((r) => r.id));
  if (error) throw error;
  const grouped = new Map<string, { user_id: string; emoji: string }[]>();
  for (const r of (data ?? []) as { message_id: string; user_id: string; emoji: string }[]) {
    const list = grouped.get(r.message_id) ?? [];
    list.push(r);
    grouped.set(r.message_id, list);
  }
  return rows.map((row) => toMessage(row, summarize(grouped.get(row.id) ?? [], viewer)));
}

dm.get("/dm/conversations", async (_req, res) => {
  const me = currentUserId(res);
  const { data, error } = await sb.rpc("sc_list_conversations", { p_user: me });
  if (error) throw error;
  res.json(
    (data ?? []).map((row: any) => ({
      id: row.conversation_id,
      isGroup: row.is_group,
      name: row.name ?? "",
      otherId: row.other_id,
      otherUsername: row.other_username,
      hasAvatar: row.has_avatar,
      lastMessageAt: row.last_message_at,
      lastPreview: row.last_preview,
      lastFromMe: row.last_sender_id === me,
      unread: Number(row.unread),
      myRole: row.my_role,
      memberCount: Number(row.member_count)
    }))
  );
});

const openSchema = z.object({ username: z.string().trim().toLowerCase().regex(USERNAME) });

dm.post("/dm/open", async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ユーザー名を入力してください。" });
    return;
  }
  const me = currentUserId(res);
  const { data: other, error } = await sb.from("sc_users").select("id").eq("username", parsed.data.username).maybeSingle();
  if (error) throw error;
  if (!other) {
    res.status(404).json({ error: "そのユーザーは見つかりません。" });
    return;
  }
  if (other.id === me) {
    res.status(400).json({ error: "自分とのDMは作成できません。" });
    return;
  }
  const { data: id, error: rpcError } = await sb.rpc("sc_open_dm", { p_me: me, p_other: other.id });
  if (rpcError) throw rpcError;
  res.json({ id });
});

const groupSchema = z.object({
  title: z.string().trim().min(1).max(40),
  usernames: z.array(z.string().trim().toLowerCase().regex(USERNAME)).min(1).max(49)
});

async function findUsers(usernames: string[]) {
  const names = [...new Set(usernames)];
  const { data, error } = await sb.from("sc_users").select("id, username").in("username", names);
  if (error) throw error;
  const found = (data ?? []) as { id: string; username: string }[];
  const missing = names.filter((n) => !found.some((u) => u.username === n));
  return { found, missing };
}

dm.post("/dm/group", async (req, res) => {
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "グループ名と、1人以上のユーザー名を入力してください。" });
    return;
  }
  const me = currentUserId(res);
  const { found, missing } = await findUsers(parsed.data.usernames);
  if (missing.length) {
    res.status(404).json({ error: `見つからないユーザー: ${missing.join(", ")}` });
    return;
  }
  const ids = found.map((u) => u.id).filter((id) => id !== me);
  if (!ids.length) {
    res.status(400).json({ error: "自分以外のメンバーを1人以上追加してください。" });
    return;
  }
  const { data: id, error } = await sb.rpc("sc_create_group", { p_me: me, p_title: parsed.data.title, p_members: ids });
  if (error) throw error;
  res.status(201).json({ id });
});

dm.get("/dm/:id", async (req, res) => {
  const id = String(req.params.id);
  const me = await membership(id, currentUserId(res));
  if (!me) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const { data: conv, error } = await sb.from("sc_conversations").select("is_group, title").eq("id", id).single();
  if (error) throw error;
  const { data: rows, error: membersError } = await sb
    .from("sc_members")
    .select("role, joined_at, sc_users(id, username, display_name, avatar_path)")
    .eq("conversation_id", id)
    .order("joined_at", { ascending: true });
  if (membersError) throw membersError;
  const members = (rows ?? []).map((row: any) => ({
    id: row.sc_users.id,
    username: row.sc_users.username,
    displayName: row.sc_users.display_name,
    hasAvatar: Boolean(row.sc_users.avatar_path),
    role: row.role as Role
  }));
  res.json({ id, isGroup: conv.is_group, title: conv.title, myRole: me.role, members });
});

const titleSchema = z.object({ title: z.string().trim().min(1).max(40) });

dm.patch("/dm/:id", async (req, res) => {
  const id = String(req.params.id);
  const me = await membership(id, currentUserId(res));
  if (!me || me.role !== "owner") {
    res.status(403).json({ error: "グループ名を変更できるのは管理者だけです。" });
    return;
  }
  const parsed = titleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "グループ名は1〜40文字で入力してください。" });
    return;
  }
  const { error } = await sb.from("sc_conversations").update({ title: parsed.data.title }).eq("id", id).eq("is_group", true);
  if (error) throw error;
  await broadcastList(id);
  res.json({ ok: true });
});

const addSchema = z.object({ usernames: z.array(z.string().trim().toLowerCase().regex(USERNAME)).min(1).max(20) });

dm.post("/dm/:id/members", async (req, res) => {
  const id = String(req.params.id);
  const me = await membership(id, currentUserId(res));
  if (!me) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const { data: conv } = await sb.from("sc_conversations").select("is_group").eq("id", id).maybeSingle();
  if (!conv?.is_group) {
    res.status(400).json({ error: "1対1のDMには追加できません。" });
    return;
  }
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "追加するユーザー名を入力してください。" });
    return;
  }
  const { found, missing } = await findUsers(parsed.data.usernames);
  if (missing.length) {
    res.status(404).json({ error: `見つからないユーザー: ${missing.join(", ")}` });
    return;
  }
  const { error } = await sb.from("sc_members").upsert(
    found.map((u) => ({ conversation_id: id, user_id: u.id, role: "member" })),
    { onConflict: "conversation_id,user_id", ignoreDuplicates: true }
  );
  if (error) throw error;
  await broadcastList(id);
  res.json({ ok: true });
});

dm.delete("/dm/:id/members/:userId", async (req, res) => {
  const id = String(req.params.id);
  const target = String(req.params.userId);
  const me = await membership(id, currentUserId(res));
  if (!me || me.role !== "owner" || !UUID.test(target) || target === currentUserId(res)) {
    res.status(403).json({ error: "このメンバーは削除できません。" });
    return;
  }
  const { error } = await sb.from("sc_members").delete().eq("conversation_id", id).eq("user_id", target);
  if (error) throw error;
  await broadcastList(id);
  res.json({ ok: true });
});

dm.post("/dm/:id/leave", async (req, res) => {
  const id = String(req.params.id);
  const userId = currentUserId(res);
  const me = await membership(id, userId);
  if (!me) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const { data: conv } = await sb.from("sc_conversations").select("is_group").eq("id", id).maybeSingle();
  if (!conv?.is_group) {
    res.status(400).json({ error: "1対1のDMは退出できません。" });
    return;
  }
  const { error } = await sb.from("sc_members").delete().eq("conversation_id", id).eq("user_id", userId);
  if (error) throw error;
  if (me.role === "owner") {
    const { data: next } = await sb
      .from("sc_members")
      .select("user_id")
      .eq("conversation_id", id)
      .order("joined_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (next) await sb.from("sc_members").update({ role: "owner" }).eq("conversation_id", id).eq("user_id", next.user_id);
  }
  const { count } = await sb.from("sc_members").select("user_id", { count: "exact", head: true }).eq("conversation_id", id);
  if (!count) {
    await sb.from("sc_conversations").delete().eq("id", id);
  } else {
    await broadcastList(id);
  }
  res.json({ ok: true });
});

dm.get("/dm/:id/messages", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const { data, error } = await sb
    .from("sc_messages")
    .select(COLUMNS)
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = ((data ?? []) as MessageRow[]).reverse();
  res.json(await withReactions(rows, me));
});

const textSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  clientId: z.string().min(1).max(64).optional()
});

dm.post("/dm/:id/messages", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const parsed = textSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "メッセージは1〜1000文字で入力してください。" });
    return;
  }
  const row = await insertMessage(id, me, { kind: "text", body: parsed.data.body }, parsed.data.body, {
    clientId: parsed.data.clientId ?? null
  });
  res.status(201).json(toMessage(row, [], parsed.data.clientId ?? null));
});

dm.post("/dm/:id/image", upload.single("file"), async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  if (!isAllowedImage(req.file)) {
    res.status(415).json({ error: "JPEG・PNG・WebP・GIF の画像を選んでください。" });
    return;
  }
  const path = await saveImage(req.file!, `dm/${id}`);
  const row = await insertMessage(id, me, { kind: "image", imagePath: path }, "写真");
  res.status(201).json(toMessage(row, []));
});

dm.post("/dm/:id/read", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  await sb.from("sc_members").update({ last_read_at: new Date().toISOString() }).eq("conversation_id", id).eq("user_id", me);
  res.json({ ok: true });
});

dm.post("/dm/messages/:messageId/reactions", async (req, res) => {
  const messageId = String(req.params.messageId);
  const emoji = typeof req.body?.emoji === "string" ? req.body.emoji : "";
  const me = currentUserId(res);
  if (!UUID.test(messageId) || !REACTIONS.includes(emoji)) {
    res.status(400).json({ error: "この絵文字は使えません。" });
    return;
  }
  const msg = await messageRow(messageId);
  if (!msg || msg.deleted_at || !(await membership(msg.conversation_id, me))) {
    res.status(404).json({ error: "メッセージが見つかりません。" });
    return;
  }
  const key = { message_id: messageId, user_id: me, emoji };
  const { data: existing } = await sb.from("sc_reactions").select("message_id").match(key).maybeSingle();
  if (existing) {
    await sb.from("sc_reactions").delete().match(key);
  } else {
    await sb.from("sc_reactions").insert(key);
  }
  await broadcastReactions(msg.conversation_id, messageId);
  res.json({ ok: true, active: !existing });
});

const editSchema = z.object({ body: z.string().trim().min(1).max(1000) });

dm.patch("/dm/messages/:messageId", async (req, res) => {
  const messageId = String(req.params.messageId);
  const me = currentUserId(res);
  const msg = UUID.test(messageId) ? await messageRow(messageId) : null;
  if (!msg) {
    res.status(404).json({ error: "メッセージが見つかりません。" });
    return;
  }
  if (msg.sender_id !== me) {
    res.status(403).json({ error: "自分のメッセージだけ編集できます。" });
    return;
  }
  if (msg.deleted_at || msg.kind !== "text") {
    res.status(400).json({ error: "このメッセージは編集できません。" });
    return;
  }
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "メッセージは1〜1000文字で入力してください。" });
    return;
  }
  const body = parsed.data.body;
  const editedAt = new Date().toISOString();
  const { error } = await sb.from("sc_messages").update({ body, edited_at: editedAt }).eq("id", messageId);
  if (error) throw error;
  // 最新のメッセージなら一覧のプレビューも更新
  await sb
    .from("sc_conversations")
    .update({ last_preview: body.slice(0, 80) })
    .eq("id", msg.conversation_id)
    .eq("last_message_at", msg.created_at);
  await broadcastToConversation(msg.conversation_id, {
    type: "message_updated",
    conversationId: msg.conversation_id,
    id: messageId,
    body,
    editedAt
  });
  await broadcastList(msg.conversation_id);
  res.json({ ok: true, body, editedAt });
});

dm.delete("/dm/messages/:messageId", async (req, res) => {
  const messageId = String(req.params.messageId);
  const me = currentUserId(res);
  const msg = UUID.test(messageId) ? await messageRow(messageId) : null;
  if (!msg || msg.deleted_at) {
    res.status(404).json({ error: "メッセージが見つかりません。" });
    return;
  }
  if (msg.sender_id !== me) {
    res.status(403).json({ error: "自分のメッセージだけ取り消せます。" });
    return;
  }
  const deletedAt = new Date().toISOString();
  const { error } = await sb
    .from("sc_messages")
    .update({ deleted_at: deletedAt, body: null, image_path: null })
    .eq("id", messageId);
  if (error) throw error;
  await sb.from("sc_reactions").delete().eq("message_id", messageId);
  if (msg.image_path) await removeImageIfUnused(msg.image_path);
  await sb
    .from("sc_conversations")
    .update({ last_preview: "送信を取り消しました" })
    .eq("id", msg.conversation_id)
    .eq("last_message_at", msg.created_at);
  await broadcastToConversation(msg.conversation_id, {
    type: "message_deleted",
    conversationId: msg.conversation_id,
    id: messageId
  });
  await broadcastList(msg.conversation_id);
  res.json({ ok: true });
});

const forwardSchema = z.object({ conversationId: z.string().regex(UUID) });

dm.post("/dm/messages/:messageId/forward", async (req, res) => {
  const messageId = String(req.params.messageId);
  const me = currentUserId(res);
  const parsed = forwardSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "送信先を選んでください。" });
    return;
  }
  const source = UUID.test(messageId) ? await messageRow(messageId) : null;
  if (!source || source.deleted_at || !(await membership(source.conversation_id, me))) {
    res.status(404).json({ error: "メッセージが見つかりません。" });
    return;
  }
  const target = parsed.data.conversationId;
  if (!(await membership(target, me))) {
    res.status(404).json({ error: "送信先が見つかりません。" });
    return;
  }
  const content =
    source.kind === "image" && source.image_path
      ? { kind: "image" as const, imagePath: source.image_path }
      : { kind: "text" as const, body: source.body ?? "" };
  if (content.kind === "text" && !content.body) {
    res.status(400).json({ error: "このメッセージは送信できません。" });
    return;
  }
  const preview = content.kind === "text" ? content.body : "写真";
  const row = await insertMessage(target, me, content, preview, { forwarded: true });
  res.status(201).json(toMessage(row, []));
});

dm.get("/dm/messages/:messageId/image", async (req, res) => {
  const messageId = String(req.params.messageId);
  if (!UUID.test(messageId)) {
    res.status(404).end();
    return;
  }
  const { data } = await sb.from("sc_messages").select("conversation_id, image_path").eq("id", messageId).maybeSingle();
  if (!data?.image_path || !(await membership(data.conversation_id as string, currentUserId(res)))) {
    res.status(404).end();
    return;
  }
  const image = await readImage(data.image_path as string);
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader("content-type", image.type);
  res.setHeader("cache-control", "private, max-age=86400");
  res.send(image.buffer);
});
