import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { friendIdsOf, friendshipOf } from "./friends.js";
import { decryptText, encryptText } from "./crypto.js";
import { fileNameOf, FILE_LIMIT, isAllowedImage, readImage, removeImage, saveFile, saveImage, upload, uploadFile } from "./media.js";
import {
  COLUMNS,
  UUID,
  type ContactInfo,
  type Content,
  broadcastList,
  broadcastReactions,
  blockedBetween,
  blockedByMe,
  broadcastToConversation,
  displayNameOf,
  findOrCreateDm,
  leaveConversation,
  memberIds,
  pollBodyOf,
  pollDataOf,
  pollPeople,
  pollView,
  postNotice,
  purgeConversation,
  insertMessage,
  membership,
  removeImageIfUnused,
  replyTargetOk,
  summarize,
  toMessage,
  type MessageRow,
  type PollData,
  type PollVote
} from "./messages.js";
import { aiEnabledFor, BOT_ID, senninaiAfterMessage, senninaiPrecheck } from "./senninai.js";
import { stampRefOk } from "./stamps.js";
import { createGame, gameAction, gameViewsFor } from "./games.js";
import { GAME_KINDS, GameError } from "./gameLogic.js";
import { sb } from "./supabase.js";
import { sendToUser } from "./hub.js";

export const dm = Router();
dm.use("/dm", requireAuth);

const USERNAME = /^[a-z0-9_]{3,20}$/;
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

type Role = "owner" | "member";
type MessageWithPath = MessageRow & { image_path: string | null; file_path: string | null };

const messageRow = async (messageId: string): Promise<MessageWithPath | null> => {
  const { data, error } = await sb
    .from("sc_messages")
    .select(`${COLUMNS}, image_path, file_path`)
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw error;
  return (data as MessageWithPath | null) ?? null;
};

// 返信先のIDを確かめる。返信しない場合は null、同じ会話にない・壊れたIDは undefined（400にする）
async function replyFrom(conversationId: string, value: unknown): Promise<string | null | undefined> {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  return (await replyTargetOk(conversationId, value)) ? value : undefined;
}

async function withReactions(rows: MessageRow[], viewer: string) {
  if (!rows.length) return [];
  const contactIds = [...new Set(rows.map((r) => r.contact_user_id).filter((v): v is string => Boolean(v)))];
  const contacts = new Map<string, ContactInfo>();
  if (contactIds.length) {
    const { data: users, error: usersError } = await sb
      .from("sc_users")
      .select("id, username, display_name, avatar_path")
      .in("id", contactIds);
    if (usersError) throw usersError;
    for (const u of (users ?? []) as { id: string; username: string; display_name: string; avatar_path: string | null }[]) {
      contacts.set(u.id, { id: u.id, username: u.username, displayName: u.display_name, hasAvatar: Boolean(u.avatar_path) });
    }
  }
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
  const polls = await pollViewsFor(rows, viewer);
  const games = await gameViewsFor(rows, viewer);
  return rows.map((row) =>
    toMessage(
      row,
      summarize(grouped.get(row.id) ?? [], viewer),
      null,
      row.contact_user_id ? contacts.get(row.contact_user_id) ?? null : null,
      polls.get(row.id) ?? null,
      games.get(row.id) ?? null
    )
  );
}

// 投票のメッセージについて、票の集計（自分の選択つき）をまとめて作る
async function pollViewsFor(rows: MessageRow[], viewer: string) {
  const views = new Map<string, ReturnType<typeof pollView>>();
  const polls = rows.map((row) => ({ row, data: pollDataOf(row) })).filter((p): p is { row: MessageRow; data: PollData } => p.data !== null);
  if (!polls.length) return views;
  const { data, error } = await sb.from("sc_poll_votes").select("message_id, user_id, option_index").in("message_id", polls.map((p) => p.row.id));
  if (error) throw error;
  const votes = new Map<string, PollVote[]>();
  for (const v of (data ?? []) as { message_id: string; user_id: string; option_index: number }[]) {
    const list = votes.get(v.message_id) ?? [];
    list.push({ user_id: v.user_id, option_index: v.option_index });
    votes.set(v.message_id, list);
  }
  const people = await pollPeople(((data ?? []) as { user_id: string }[]).map((v) => v.user_id));
  for (const p of polls) views.set(p.row.id, pollView(p.data, votes.get(p.row.id) ?? [], viewer, p.row.sender_id, people));
  return views;
}

// 投票の票が変わったことを、会話の全員へ知らせる（自分の選択は人ごとに違うので、人ごとに作る）
async function broadcastPoll(conversationId: string, messageId: string) {
  const row = await messageRow(messageId);
  const data = row ? pollDataOf(row) : null;
  if (!row || !data) return;
  const { data: rows, error } = await sb.from("sc_poll_votes").select("user_id, option_index").eq("message_id", messageId);
  if (error) throw error;
  const votes = (rows ?? []) as PollVote[];
  const people = await pollPeople(votes.map((v) => v.user_id));
  for (const uid of await memberIds(conversationId)) {
    sendToUser(uid, { type: "poll", conversationId, messageId, poll: pollView(data, votes, uid, row.sender_id, people) });
  }
}

dm.get("/dm/conversations", async (_req, res) => {
  const me = currentUserId(res);
  const { data, error } = await sb.rpc("sc_list_conversations", { p_user: me });
  if (error) throw error;
  // senninai（AIチャット）は、設定でAI機能をオンにしている人の一覧にだけ出す
  const aiOn = await aiEnabledFor(me);
  res.json(
    (data ?? [])
      .filter((row: any) => aiOn || row.other_id !== BOT_ID)
      .map((row: any) => ({
        id: row.conversation_id,
        isGroup: row.is_group,
        name: row.name ?? "",
        otherId: row.other_id,
        otherUsername: row.other_username,
        hasAvatar: row.has_avatar,
        lastMessageAt: row.last_message_at,
        lastPreview: decryptText(row.last_preview),
        lastFromMe: row.last_sender_id === me,
        unread: Number(row.unread),
        myRole: row.my_role,
        memberCount: Number(row.member_count),
        muted: Boolean(row.muted)
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
  if (await blockedBetween(me, other.id)) {
    res.status(403).json({ error: "このユーザーとはトークできません。" });
    return;
  }
  if (other.id === BOT_ID && !(await aiEnabledFor(me))) {
    res.status(400).json({ error: "senninaiを使うには、設定でAI機能をオンにしてください。" });
    return;
  }
  const { id } = await findOrCreateDm(me, other.id);
  res.json({ id });
});

const groupSchema = z.object({
  title: z.string().trim().min(1).max(40),
  usernames: z.array(z.string().trim().toLowerCase().regex(USERNAME)).min(1).max(49)
});

async function findUsers(usernames: string[]) {
  const names = [...new Set(usernames)];
  const { data, error } = await sb.from("sc_users").select("id, username, display_name").in("username", names);
  if (error) throw error;
  const found = (data ?? []) as { id: string; username: string; display_name: string }[];
  const missing = names.filter((n) => !found.some((u) => u.username === n));
  return { found, missing };
}

// グループに入れられるのは友だちだけ（自分以外で友だちでないユーザーがいたら拒否する）
async function strangersAmong(found: { id: string; username: string }[], me: string) {
  const friendIds = await friendIdsOf(me);
  return found.filter((u) => u.id !== me && !friendIds.has(u.id)).map((u) => u.username);
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
  const strangers = await strangersAmong(found, me);
  if (strangers.length) {
    res.status(400).json({ error: `友だちではないユーザーは追加できません: ${strangers.join(", ")}` });
    return;
  }
  const ids = found.map((u) => u.id).filter((id) => id !== me);
  if (!ids.length) {
    res.status(400).json({ error: "自分以外のメンバーを1人以上追加してください。" });
    return;
  }
  const { data: id, error } = await sb.rpc("sc_create_group", { p_me: me, p_title: parsed.data.title, p_members: ids });
  if (error) throw error;
  for (const u of found) {
    if (u.id !== me) await postNotice(String(id), u.id, `${u.display_name}が参加しました`);
  }
  res.status(201).json({ id });
});

dm.get("/dm/:id", async (req, res) => {
  const id = String(req.params.id);
  const me = await membership(id, currentUserId(res));
  if (!me) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const { data: conv, error } = await sb.from("sc_conversations").select("is_group, title, avatar_path").eq("id", id).single();
  if (error) throw error;
  const { data: rows, error: membersError } = await sb
    .from("sc_members")
    .select("role, joined_at, last_read_at, muted, sc_users(id, username, display_name, avatar_path)")
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
  // 既読の表示用：自分以外のメンバーがどこまで読んだか（last_read_at）
  const viewer = currentUserId(res);
  const readBy = (rows ?? [])
    .filter((row: any) => row.sc_users.id !== viewer)
    .map((row: any) => ({ id: row.sc_users.id, lastReadAt: row.last_read_at as string }));
  // 1対1の会話では、相手とのフレンド状態も返す（申請の許可・拒否バナーに使う）
  const other = members.find((m) => m.id !== viewer);
  const friendship = conv.is_group || !other ? null : await friendshipOf(viewer, other.id);
  const muted = Boolean((rows ?? []).find((row: any) => row.sc_users.id === viewer)?.muted);
  res.json({ id, isGroup: conv.is_group, title: conv.title, hasAvatar: Boolean(conv.avatar_path), myRole: me.role, muted, members, readBy, friendship });
});

const titleSchema = z.object({ title: z.string().trim().min(1).max(40) });

dm.post("/dm/:id", async (req, res) => {
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
  await postNotice(id, currentUserId(res), `ルーム名が「${parsed.data.title}」に変わりました`);
  await broadcastList(id);
  res.json({ ok: true });
});

const addSchema = z.object({ usernames: z.array(z.string().trim().toLowerCase().regex(USERNAME)).min(1).max(20) });

// グループのアイコン画像（名前の変更と同じく管理者だけ変えられる）
dm.post("/dm/:id/avatar", upload.single("file"), async (req, res) => {
  const id = String(req.params.id);
  const me = await membership(id, currentUserId(res));
  if (!me || me.role !== "owner") {
    res.status(403).json({ error: "アイコンを変更できるのは管理者だけです。" });
    return;
  }
  if (!isAllowedImage(req.file)) {
    res.status(415).json({ error: "JPEG・PNG・WebP・GIF の画像を選んでください。" });
    return;
  }
  const { data: conv, error } = await sb.from("sc_conversations").select("is_group, avatar_path").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!conv?.is_group) {
    res.status(400).json({ error: "グループ以外のアイコンは変更できません。" });
    return;
  }
  const path = await saveImage(req.file!, `groups/${id}`);
  const { error: updateError } = await sb.from("sc_conversations").update({ avatar_path: path }).eq("id", id);
  if (updateError) throw updateError;
  await removeImage(conv.avatar_path ?? null);
  await broadcastList(id);
  res.json({ hasAvatar: true });
});

dm.get("/dm/:id/avatar", async (req, res) => {
  const id = String(req.params.id);
  if (!(await membership(id, currentUserId(res)))) {
    res.status(404).end();
    return;
  }
  const { data } = await sb.from("sc_conversations").select("avatar_path").eq("id", id).maybeSingle();
  if (!data?.avatar_path) {
    res.status(404).end();
    return;
  }
  const image = await readImage(data.avatar_path);
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader("content-type", image.type);
  res.setHeader("cache-control", "private, no-cache");
  res.send(image.buffer);
});

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
  const strangers = await strangersAmong(found, currentUserId(res));
  if (strangers.length) {
    res.status(400).json({ error: `友だちではないユーザーは追加できません: ${strangers.join(", ")}` });
    return;
  }
  const { data: already, error: alreadyError } = await sb.from("sc_members").select("user_id").eq("conversation_id", id).in("user_id", found.map((u) => u.id));
  if (alreadyError) throw alreadyError;
  const existing = new Set(((already ?? []) as { user_id: string }[]).map((r) => r.user_id));
  const joining = found.filter((u) => !existing.has(u.id));
  const { error } = await sb.from("sc_members").upsert(
    found.map((u) => ({ conversation_id: id, user_id: u.id, role: "member" })),
    { onConflict: "conversation_id,user_id", ignoreDuplicates: true }
  );
  if (error) throw error;
  for (const u of joining) await postNotice(id, u.id, `${u.display_name}が参加しました`);
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
  const targetName = await displayNameOf(target);
  const { error } = await sb.from("sc_members").delete().eq("conversation_id", id).eq("user_id", target);
  if (error) throw error;
  await postNotice(id, currentUserId(res), `${targetName}が削除されました`);
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
  const leaverName = await displayNameOf(userId);
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
    await purgeConversation(id);
  } else {
    await postNotice(id, userId, `${leaverName}が抜けました`);
    await broadcastList(id);
  }
  res.json({ ok: true });
});

// グループを削除する（管理者だけ。オープンチャットも同じ）。全員の画面から消え、メッセージ・画像・ファイルも完全に消える
dm.post("/dm/:id/disband", async (req, res) => {
  const id = String(req.params.id);
  const me = await membership(id, currentUserId(res));
  if (!me || me.role !== "owner") {
    res.status(403).json({ error: "グループを削除できるのは管理者だけです。" });
    return;
  }
  const { data: conv, error } = await sb.from("sc_conversations").select("is_group").eq("id", id).maybeSingle();
  if (error) throw error;
  if (conv?.is_group !== true) {
    res.status(400).json({ error: "グループ以外は削除できません。" });
    return;
  }
  await purgeConversation(id);
  res.json({ ok: true });
});

// 通知のオン・オフ（このトークだけ。自分の行だけ変える）
const muteSchema = z.object({ muted: z.boolean() });
dm.post("/dm/:id/mute", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const parsed = muteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "通知の設定が正しくありません。" });
    return;
  }
  const { error } = await sb.from("sc_members").update({ muted: parsed.data.muted }).eq("conversation_id", id).eq("user_id", me);
  if (error) throw error;
  res.json({ ok: true, muted: parsed.data.muted });
});

// 1対1のトークを削除する（自分の画面から消す。相手の画面には残る。最後の1人が消すと完全に消える）
// グループは「退出」（/dm/:id/leave）で、同じく最後の1人が抜けると完全に消える
dm.post("/dm/:id/delete", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const { data: conv } = await sb.from("sc_conversations").select("is_group").eq("id", id).maybeSingle();
  if (conv?.is_group === true) {
    res.status(400).json({ error: "グループは退出してから削除されます。" });
    return;
  }
  await leaveConversation(id, me);
  res.json({ ok: true });
});

dm.get("/dm/:id/messages", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  // ?before=<ISO時刻> を渡すと、それより前の古いメッセージを50件返す（過去ログの読み込み用）
  const beforeRaw = typeof req.query.before === "string" ? req.query.before : null;
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (before && Number.isNaN(before.getTime())) {
    res.status(400).json({ error: "日時の指定が正しくありません。" });
    return;
  }
  let query = sb.from("sc_messages").select(COLUMNS).eq("conversation_id", id);
  if (before) query = query.lt("created_at", before.toISOString());
  const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  // 自分がブロックしている人の発言は表示しない
  const hidden = await blockedByMe(me);
  const rows = ((data ?? []) as MessageRow[]).reverse().filter((r) => !hidden.has(r.sender_id));
  res.json(await withReactions(rows, me));
});

const textSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  clientId: z.string().min(1).max(64).optional(),
  replyToId: z.string().regex(UUID).nullish()
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
  const replyToId = await replyFrom(id, parsed.data.replyToId);
  if (replyToId === undefined) {
    res.status(400).json({ error: "返信先のメッセージが見つかりません。" });
    return;
  }
  const problem = await senninaiPrecheck(id, me, parsed.data.body);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  const row = await insertMessage(id, me, { kind: "text", body: parsed.data.body }, parsed.data.body, {
    clientId: parsed.data.clientId ?? null,
    replyToId
  });
  void senninaiAfterMessage(id, me, parsed.data.body, row);
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
  const replyToId = await replyFrom(id, req.body?.replyToId);
  if (replyToId === undefined) {
    res.status(400).json({ error: "返信先のメッセージが見つかりません。" });
    return;
  }
  const path = await saveImage(req.file!, `dm/${id}`);
  const row = await insertMessage(id, me, { kind: "image", imagePath: path }, "写真", { replyToId });
  res.status(201).json(toMessage(row, []));
});

// スタンプ（画像とは別の種類。組み込みは builtin:ファイル名、自分のものは user:ID）
dm.post("/dm/:id/stamp", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const stampRef = typeof req.body?.stampRef === "string" ? req.body.stampRef : "";
  if (!(await stampRefOk(stampRef, me))) {
    res.status(400).json({ error: "スタンプが見つかりません。" });
    return;
  }
  const replyToId = await replyFrom(id, req.body?.replyToId);
  if (replyToId === undefined) {
    res.status(400).json({ error: "返信先のメッセージが見つかりません。" });
    return;
  }
  const row = await insertMessage(id, me, { kind: "stamp", stampRef }, "スタンプ", { replyToId });
  res.status(201).json(toMessage(row, []));
});

dm.post("/dm/:id/read", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const readAt = new Date().toISOString();
  const { error } = await sb.from("sc_members").update({ last_read_at: readAt }).eq("conversation_id", id).eq("user_id", me);
  if (error) throw error;
  // 既読をメンバー全員へ即時通知（相手の画面に「既読」を出すため）
  await broadcastToConversation(id, { type: "read", conversationId: id, userId: me, readAt });
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

dm.post("/dm/messages/:messageId", async (req, res) => {
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
  const { error } = await sb.from("sc_messages").update({ body: encryptText(body), edited_at: editedAt }).eq("id", messageId);
  if (error) throw error;
  // 最新のメッセージなら一覧のプレビューも更新
  await sb
    .from("sc_conversations")
    .update({ last_preview: encryptText(body.slice(0, 80)) })
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
    .update({ deleted_at: deletedAt, body: null, image_path: null, file_path: null, contact_user_id: null })
    .eq("id", messageId);
  if (error) throw error;
  await sb.from("sc_reactions").delete().eq("message_id", messageId);
  if (msg.image_path) await removeImageIfUnused(msg.image_path);
  if (msg.file_path) await removeImageIfUnused(msg.file_path);
  await sb
    .from("sc_conversations")
    .update({ last_preview: encryptText("送信を取り消しました") })
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

const pollSchema = z.object({
  question: z.string().trim().min(1).max(100),
  options: z.array(z.string().trim().min(1).max(60)).min(2).max(10),
  multiple: z.boolean().optional(),
  anonymous: z.boolean().optional(),
  replyToId: z.string().regex(UUID).nullish()
});

// 投票を作る（「＋」→「投票」から送る）
dm.post("/dm/:id/poll", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const parsed = pollSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "質問（100文字まで）と選択肢（2〜10個、各60文字まで）を入力してください。" });
    return;
  }
  if (new Set(parsed.data.options).size !== parsed.data.options.length) {
    res.status(400).json({ error: "同じ選択肢があります。" });
    return;
  }
  const replyToId = await replyFrom(id, parsed.data.replyToId);
  if (replyToId === undefined) {
    res.status(400).json({ error: "返信先のメッセージが見つかりません。" });
    return;
  }
  const content: Content = {
    kind: "poll",
    question: parsed.data.question,
    options: parsed.data.options,
    multiple: Boolean(parsed.data.multiple),
    anonymous: Boolean(parsed.data.anonymous)
  };
  const row = await insertMessage(id, me, content, `投票: ${content.question}`.slice(0, 80), { replyToId });
  res.status(201).json((await withReactions([row], me))[0]);
});

const voteSchema = z.object({ optionIndex: z.number().int().min(0).max(9) });

const gameCreateSchema = z.object({ kind: z.enum(GAME_KINDS) });

// ミニゲームを作る（グループのトークだけ。1対1では使えない）
dm.post("/dm/:id/game", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const { data: conv, error } = await sb.from("sc_conversations").select("is_group").eq("id", id).maybeSingle();
  if (error) throw error;
  if (conv?.is_group !== true) {
    res.status(400).json({ error: "ミニゲームはグループのトークで遊べます。" });
    return;
  }
  const parsed = gameCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ゲームを選んでください。" });
    return;
  }
  const row = await createGame(id, me, parsed.data.kind);
  res.status(201).json((await withReactions([row], me))[0]);
});

const gameActionSchema = z.object({
  action: z.enum(["join", "start", "cancel", "move", "buzz", "answer", "next", "hand", "guess"]),
  index: z.number().int().optional(),
  choice: z.number().int().optional(),
  hand: z.enum(["rock", "scissors", "paper"]).optional(),
  value: z.number().int().optional()
});

// ミニゲームの操作（参加・開始・中止・プレイ）。結果は会話の全員へ届く
dm.post("/dm/messages/:messageId/game", async (req, res) => {
  const messageId = String(req.params.messageId);
  const me = currentUserId(res);
  const parsed = gameActionSchema.safeParse(req.body);
  if (!UUID.test(messageId) || !parsed.success) {
    res.status(400).json({ error: "その操作はできません。" });
    return;
  }
  try {
    await gameAction(messageId, me, parsed.data);
  } catch (err) {
    if (err instanceof GameError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  res.json({ ok: true });
});

// 選択肢を選ぶ／選び直す。同じ選択肢をもう一度押すと取り消す。単一選択では前の選択を外す
dm.post("/dm/messages/:messageId/vote", async (req, res) => {
  const messageId = String(req.params.messageId);
  const me = currentUserId(res);
  const parsed = voteSchema.safeParse(req.body);
  const msg = UUID.test(messageId) ? await messageRow(messageId) : null;
  const poll = msg ? pollDataOf(msg) : null;
  if (!msg || !poll || !(await membership(msg.conversation_id, me))) {
    res.status(404).json({ error: "投票が見つかりません。" });
    return;
  }
  if (!parsed.success || parsed.data.optionIndex >= poll.options.length) {
    res.status(400).json({ error: "選択肢が見つかりません。" });
    return;
  }
  if (poll.closedAt) {
    res.status(400).json({ error: "この投票は締め切られています。" });
    return;
  }
  const index = parsed.data.optionIndex;
  const { data: mine, error } = await sb.from("sc_poll_votes").select("option_index").eq("message_id", messageId).eq("user_id", me);
  if (error) throw error;
  const chosen = (mine ?? []).some((v: { option_index: number }) => v.option_index === index);
  if (chosen) {
    const { error: deleteError } = await sb.from("sc_poll_votes").delete().match({ message_id: messageId, user_id: me, option_index: index });
    if (deleteError) throw deleteError;
  } else {
    if (!poll.multiple && (mine ?? []).length) {
      const { error: clearError } = await sb.from("sc_poll_votes").delete().match({ message_id: messageId, user_id: me });
      if (clearError) throw clearError;
    }
    const { error: insertError } = await sb.from("sc_poll_votes").insert({ message_id: messageId, user_id: me, option_index: index });
    if (insertError) throw insertError;
  }
  await broadcastPoll(msg.conversation_id, messageId);
  res.json({ ok: true });
});

// 投票を締め切る（作った人だけ。締め切ると以後は選べません。結果は残ります）
dm.post("/dm/messages/:messageId/poll/close", async (req, res) => {
  const messageId = String(req.params.messageId);
  const me = currentUserId(res);
  const msg = UUID.test(messageId) ? await messageRow(messageId) : null;
  const poll = msg ? pollDataOf(msg) : null;
  if (!msg || !poll || !(await membership(msg.conversation_id, me))) {
    res.status(404).json({ error: "投票が見つかりません。" });
    return;
  }
  if (msg.sender_id !== me) {
    res.status(403).json({ error: "締め切れるのは投票を作った人だけです。" });
    return;
  }
  if (!poll.closedAt) {
    const closed: PollData = { ...poll, closedAt: new Date().toISOString() };
    const { error } = await sb.from("sc_messages").update({ body: encryptText(pollBodyOf(closed)) }).eq("id", messageId);
    if (error) throw error;
    await broadcastPoll(msg.conversation_id, messageId);
  }
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
  if (source.kind === "poll" || source.kind === "game") {
    res.status(400).json({ error: "投票・ミニゲームは送信できません。" });
    return;
  }
  const target = parsed.data.conversationId;
  if (!(await membership(target, me))) {
    res.status(404).json({ error: "送信先が見つかりません。" });
    return;
  }
  // 元のメッセージは暗号化されているので、転送する前に復号する
  let content: Content = { kind: "text", body: decryptText(source.body) ?? "" };
  if (source.kind === "image" && source.image_path) {
    content = { kind: "image", imagePath: source.image_path };
  } else if (source.kind === "file" && source.file_path) {
    content = { kind: "file", filePath: source.file_path, fileName: source.file_name ?? "file", fileSize: Number(source.file_size ?? 0) };
  } else if (source.kind === "contact" && source.contact_user_id) {
    content = { kind: "contact", contactUserId: source.contact_user_id };
  } else if (source.kind === "stamp" && source.stamp_ref) {
    // スタンプは本文を持たないので、スタンプの参照をそのまま転送する
    if (!(await stampRefOk(source.stamp_ref, me))) {
      res.status(400).json({ error: "このスタンプは送信できません。" });
      return;
    }
    content = { kind: "stamp", stampRef: source.stamp_ref };
  }
  if (content.kind === "text" && !content.body) {
    res.status(400).json({ error: "このメッセージは送信できません。" });
    return;
  }
  const preview = previewOf(content);
  const row = await insertMessage(target, me, content, preview, { forwarded: true });
  res.status(201).json((await withReactions([row], me))[0]);
});

// 送信するメッセージの一覧表示用の短い説明
function previewOf(content: Content) {
  if (content.kind === "text") return content.body;
  if (content.kind === "image") return "写真";
  if (content.kind === "stamp") return "スタンプ";
  if (content.kind === "file") return `ファイル: ${content.fileName}`.slice(0, 80);
  return "連絡先";
}

// ファイル添付（画像以外のすべて・20MBまで）
dm.post("/dm/:id/file", uploadFile.single("file"), async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const file = req.file;
  if (!file || file.size === 0) {
    res.status(400).json({ error: "ファイルを選んでください。" });
    return;
  }
  if (file.size > FILE_LIMIT) {
    res.status(413).json({ error: "ファイルは20MB以下にしてください。" });
    return;
  }
  const replyToId = await replyFrom(id, req.body?.replyToId);
  if (replyToId === undefined) {
    res.status(400).json({ error: "返信先のメッセージが見つかりません。" });
    return;
  }
  const name = fileNameOf(file);
  const path = await saveFile(file, `dm/${id}/files`);
  const row = await insertMessage(
    id,
    me,
    { kind: "file", filePath: path, fileName: name, fileSize: file.size },
    previewOf({ kind: "file", filePath: path, fileName: name, fileSize: file.size }),
    { replyToId }
  );
  res.status(201).json((await withReactions([row], me))[0]);
});

// 連絡先（SoraChatのユーザー）を送る
const contactSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME),
  replyToId: z.string().regex(UUID).nullish()
});

dm.post("/dm/:id/contact", async (req, res) => {
  const id = String(req.params.id);
  const me = currentUserId(res);
  if (!(await membership(id, me))) {
    res.status(404).json({ error: "会話が見つかりません。" });
    return;
  }
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ユーザー名を選んでください。" });
    return;
  }
  const { data: user, error } = await sb.from("sc_users").select("id").eq("username", parsed.data.username).maybeSingle();
  if (error) throw error;
  if (!user) {
    res.status(404).json({ error: "そのユーザーは見つかりません。" });
    return;
  }
  if (user.id === me) {
    res.status(400).json({ error: "自分の連絡先は送れません。" });
    return;
  }
  const replyToId = await replyFrom(id, parsed.data.replyToId);
  if (replyToId === undefined) {
    res.status(400).json({ error: "返信先のメッセージが見つかりません。" });
    return;
  }
  const content: Content = { kind: "contact", contactUserId: user.id };
  const row = await insertMessage(id, me, content, previewOf(content), { replyToId });
  res.status(201).json((await withReactions([row], me))[0]);
});

// ファイルのダウンロード（常に添付として返し、ブラウザでの実行を防ぐ）
dm.get("/dm/messages/:messageId/file", async (req, res) => {
  const messageId = String(req.params.messageId);
  const { data, error } = await sb
    .from("sc_messages")
    .select("conversation_id, file_path, file_name, deleted_at")
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.file_path || data.deleted_at || !(await membership(data.conversation_id as string, currentUserId(res)))) {
    res.status(404).json({ error: "ファイルが見つかりません。" });
    return;
  }
  const file = await readImage(data.file_path as string);
  if (!file) {
    res.status(404).json({ error: "ファイルが見つかりません。" });
    return;
  }
  const name = String(data.file_name ?? "file");
  res.setHeader("content-type", "application/octet-stream");
  res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("x-content-type-options", "nosniff");
  res.send(file.buffer);
});

// トークの中で表示するためのファイル（PDF と、テキスト系のファイル）。それ以外は 415 を返す
// 中身も確かめる（PDF は %PDF- で始まる、テキストは NUL を含まない）。ダウンロードは従来の /file を使う
const TEXT_VIEW_EXTENSIONS = new Set(["txt", "md", "csv", "log", "json"]);
dm.get("/dm/messages/:messageId/file/view", async (req, res) => {
  const messageId = String(req.params.messageId);
  if (!UUID.test(messageId)) {
    res.status(404).json({ error: "ファイルが見つかりません。" });
    return;
  }
  const { data, error } = await sb
    .from("sc_messages")
    .select("conversation_id, file_path, file_name, deleted_at")
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.file_path || data.deleted_at || !(await membership(data.conversation_id as string, currentUserId(res)))) {
    res.status(404).json({ error: "ファイルが見つかりません。" });
    return;
  }
  const file = await readImage(data.file_path as string);
  if (!file) {
    res.status(404).json({ error: "ファイルが見つかりません。" });
    return;
  }
  const name = String(data.file_name ?? "file");
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const buffer = file.buffer;
  const isPdf = ext === "pdf" && buffer.subarray(0, 5).equals(Buffer.from("%PDF-"));
  const isText = TEXT_VIEW_EXTENSIONS.has(ext) && !buffer.subarray(0, 8000).includes(0) && buffer.length <= 5 * 1024 * 1024;
  if (!isPdf && !isText) {
    res.status(415).json({ error: "このファイルはトークの中では表示できません。" });
    return;
  }
  res.setHeader("content-type", isPdf ? "application/pdf" : "text/plain; charset=utf-8");
  res.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "private, no-cache");
  res.send(buffer);
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
