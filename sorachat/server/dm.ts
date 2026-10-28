import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { isAllowedImage, readImage, saveImage, upload } from "./media.js";
import { notifyRecipient } from "./push.js";
import { sb } from "./supabase.js";

export const dm = Router();
dm.use("/dm", requireAuth);

const UUID = /^[0-9a-f-]{36}$/i;
const USERNAME = /^[a-z0-9_]{3,20}$/;
const COLUMNS = "id, conversation_id, sender_id, kind, body, created_at";
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: "text" | "image";
  body: string | null;
  created_at: string;
};

type Role = "owner" | "member";
type Reaction = { emoji: string; count: number; mine: boolean };

const toMessage = (row: MessageRow, reactions: Reaction[]) => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  kind: row.kind,
  body: row.body,
  imageUrl: row.kind === "image" ? `/api/dm/messages/${row.id}/image` : null,
  createdAt: row.created_at,
  reactions
});

async function membership(conversationId: string, userId: string): Promise<{ role: Role } | null> {
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

async function withReactions(rows: MessageRow[], viewer: string) {
  if (!rows.length) return [];
  const { data, error } = await sb
    .from("sc_reactions")
    .select("message_id, user_id, emoji")
    .in("message_id", rows.map((r) => r.id));
  if (error) throw error;
  const summary = new Map<string, Map<string, Reaction>>();
  for (const r of (data ?? []) as { message_id: string; user_id: string; emoji: string }[]) {
    const byEmoji = summary.get(r.message_id) ?? new Map<string, Reaction>();
    const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    entry.count += 1;
    if (r.user_id === viewer) entry.mine = true;
    byEmoji.set(r.emoji, entry);
    summary.set(r.message_id, byEmoji);
  }
  return rows.map((row) => toMessage(row, [...(summary.get(row.id)?.values() ?? [])]));
}

async function insertMessage(
  conversationId: string,
  senderId: string,
  content: { kind: "text"; body: string } | { kind: "image"; imagePath: string },
  preview: string
) {
  const now = new Date().toISOString();
  const row =
    content.kind === "text"
      ? { kind: "text", body: content.body, image_path: null }
      : { kind: "image", body: null, image_path: content.imagePath };
  const { data, error } = await sb
    .from("sc_messages")
    .insert({ conversation_id: conversationId, sender_id: senderId, ...row })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  await sb
    .from("sc_conversations")
    .update({ last_message_at: now, last_preview: preview.slice(0, 80), last_sender_id: senderId })
    .eq("id", conversationId);
  await sb
    .from("sc_members")
    .update({ last_read_at: now })
    .eq("conversation_id", conversationId)
    .eq("user_id", senderId);

  const [{ data: sender }, { data: conv }, { data: others }] = await Promise.all([
    sb.from("sc_users").select("display_name").eq("id", senderId).maybeSingle(),
    sb.from("sc_conversations").select("is_group, title").eq("id", conversationId).maybeSingle(),
    sb.from("sc_members").select("user_id").eq("conversation_id", conversationId).neq("user_id", senderId)
  ]);
  const senderName = conv?.is_group
    ? `${sender?.display_name ?? "メンバー"}（${conv.title ?? "グループ"}）`
    : sender?.display_name ?? "新着メッセージ";
  for (const other of others ?? []) {
    void notifyRecipient({
      recipientId: other.user_id as string,
      senderName,
      preview: preview.slice(0, 80),
      conversationId
    });
  }
  return data as MessageRow;
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
  if (!count) await sb.from("sc_conversations").delete().eq("id", id);
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

const textSchema = z.object({ body: z.string().trim().min(1).max(1000) });

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
  const row = await insertMessage(id, me, { kind: "text", body: parsed.data.body }, parsed.data.body);
  res.status(201).json(toMessage(row, []));
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
  const { data: msg } = await sb.from("sc_messages").select("conversation_id").eq("id", messageId).maybeSingle();
  if (!msg || !(await membership(msg.conversation_id as string, me))) {
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
  res.json({ ok: true, active: !existing });
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
