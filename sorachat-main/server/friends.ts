import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { UUID, blockedBetween } from "./messages.js";
import { avatarVersionOf } from "./avatarVersion.js";
import { BOT_ID } from "./senninai.js";
import { sb } from "./supabase.js";

export const friends = Router();
friends.use("/friends", requireAuth);

const USERNAME = /^[a-z0-9_]{3,20}$/;

export type FriendInfo = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  hasAvatar: boolean;
  // 画像の版（画像のパス）。変わったら画像を取り直すための目印
  avatarVersion: string | null;
  coverTheme: string;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_path: string | null;
  cover_theme: string | null;
};

// 自分から見た相手との関係
// friend: 友だち / incoming: 相手から申請が来ている / outgoing: こちらから申請中 / none: 関係なし
export type FriendshipState = "friend" | "incoming" | "outgoing" | "none";

const toInfo = (u: UserRow): FriendInfo => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  bio: u.bio ?? "",
  hasAvatar: Boolean(u.avatar_path),
  avatarVersion: avatarVersionOf(u.avatar_path),
  coverTheme: u.cover_theme ?? "green"
});

// 自分の友だちのID一覧（グループ作成・追加の判定や、検索結果の「追加済み」表示に使う）
// 承認された友だちだけを含む（申請中は含まない）
export async function friendIdsOf(userId: string): Promise<Set<string>> {
  const { data, error } = await sb.from("sc_friends").select("friend_id").eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((row: { friend_id: string }) => row.friend_id));
}

export async function friendshipOf(me: string, other: string): Promise<FriendshipState> {
  const { data: friend, error: friendError } = await sb
    .from("sc_friends")
    .select("friend_id")
    .eq("user_id", me)
    .eq("friend_id", other)
    .maybeSingle();
  if (friendError) throw friendError;
  if (friend) return "friend";

  const { data: requests, error: requestError } = await sb
    .from("sc_friend_requests")
    .select("from_id, to_id")
    .or(`and(from_id.eq.${me},to_id.eq.${other}),and(from_id.eq.${other},to_id.eq.${me})`);
  if (requestError) throw requestError;
  const rows = (requests ?? []) as { from_id: string; to_id: string }[];
  if (rows.some((r) => r.from_id === other)) return "incoming";
  if (rows.some((r) => r.from_id === me)) return "outgoing";
  return "none";
}

// 2人を友だちにする（相互に1行ずつ保存し、残っている申請は消す）
async function befriend(a: string, b: string) {
  const { error: upsertError } = await sb.from("sc_friends").upsert(
    [
      { user_id: a, friend_id: b },
      { user_id: b, friend_id: a }
    ],
    { onConflict: "user_id,friend_id", ignoreDuplicates: true }
  );
  if (upsertError) throw upsertError;
  const { error: deleteError } = await sb
    .from("sc_friend_requests")
    .delete()
    .or(`and(from_id.eq.${a},to_id.eq.${b}),and(from_id.eq.${b},to_id.eq.${a})`);
  if (deleteError) throw deleteError;
}

export async function usersByIds(ids: string[]): Promise<FriendInfo[]> {
  if (!ids.length) return [];
  const { data, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, bio, avatar_path, cover_theme")
    .in("id", ids)
    .order("display_name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => toInfo(row as UserRow));
}

friends.get("/friends", async (_req, res) => {
  const me = currentUserId(res);
  const ids = [...(await friendIdsOf(me))];
  res.json(await usersByIds(ids));
});

// 届いている申請（incoming）と、こちらが送って返事待ちの申請（outgoing）
friends.get("/friends/requests", async (_req, res) => {
  const me = currentUserId(res);
  const [{ data: inRows, error: inError }, { data: outRows, error: outError }] = await Promise.all([
    sb.from("sc_friend_requests").select("from_id").eq("to_id", me),
    sb.from("sc_friend_requests").select("to_id").eq("from_id", me)
  ]);
  if (inError) throw inError;
  if (outError) throw outError;
  const incoming = await usersByIds((inRows ?? []).map((r: { from_id: string }) => r.from_id));
  const outgoing = await usersByIds((outRows ?? []).map((r: { to_id: string }) => r.to_id));
  res.json({ incoming, outgoing });
});

const addSchema = z.object({ username: z.string().trim().toLowerCase().regex(USERNAME) });

// フレンド申請を送る。相手がすでに申請してきていれば、そのまま友だちになる
friends.post("/friends", async (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ユーザー名を入力してください。" });
    return;
  }
  const me = currentUserId(res);
  const { data: other, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, bio, avatar_path, cover_theme")
    .eq("username", parsed.data.username)
    .maybeSingle();
  if (error) throw error;
  if (!other) {
    res.status(404).json({ error: "そのユーザーは見つかりません。" });
    return;
  }
  if (other.id === me) {
    res.status(400).json({ error: "自分を友だちに追加することはできません。" });
    return;
  }
  if (await blockedBetween(me, other.id)) {
    res.status(400).json({ error: "このユーザーには申請できません。" });
    return;
  }
  if (other.id === BOT_ID) {
    res.status(400).json({ error: "senninaiは友だちにできません。設定でAI機能をオンにすると、トーク一覧から使えます。" });
    return;
  }

  const state = await friendshipOf(me, other.id);
  if (state === "friend") {
    res.json({ status: "friend", ...toInfo(other as UserRow) });
    return;
  }
  if (state === "outgoing") {
    res.json({ status: "outgoing", ...toInfo(other as UserRow) });
    return;
  }
  if (state === "incoming") {
    await befriend(me, other.id);
    res.status(201).json({ status: "friend", ...toInfo(other as UserRow) });
    return;
  }
  const { error: insertError } = await sb.from("sc_friend_requests").insert({ from_id: me, to_id: other.id });
  if (insertError) throw insertError;
  res.status(201).json({ status: "outgoing", ...toInfo(other as UserRow) });
});

// 届いた申請を許可する
friends.post("/friends/requests/:userId/accept", async (req, res) => {
  const target = String(req.params.userId);
  if (!UUID.test(target)) {
    res.status(404).json({ error: "リクエストが見つかりません。" });
    return;
  }
  const me = currentUserId(res);
  const { data, error } = await sb
    .from("sc_friend_requests")
    .select("from_id")
    .eq("from_id", target)
    .eq("to_id", me)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "リクエストが見つかりません。" });
    return;
  }
  await befriend(me, target);
  res.json({ status: "friend" });
});

// 届いた申請を拒否する（相手には通知されない）
friends.post("/friends/requests/:userId/decline", async (req, res) => {
  const target = String(req.params.userId);
  if (!UUID.test(target)) {
    res.json({ status: "none" });
    return;
  }
  const me = currentUserId(res);
  const { error } = await sb.from("sc_friend_requests").delete().eq("from_id", target).eq("to_id", me);
  if (error) throw error;
  res.json({ status: "none" });
});

// こちらが送った申請を取り消す
friends.delete("/friends/requests/:userId", async (req, res) => {
  const target = String(req.params.userId);
  if (!UUID.test(target)) {
    res.json({ status: "none" });
    return;
  }
  const me = currentUserId(res);
  const { error } = await sb.from("sc_friend_requests").delete().eq("from_id", me).eq("to_id", target);
  if (error) throw error;
  res.json({ status: "none" });
});

friends.delete("/friends/:userId", async (req, res) => {
  const target = String(req.params.userId);
  if (!UUID.test(target)) {
    res.status(404).json({ error: "友だちが見つかりません。" });
    return;
  }
  const me = currentUserId(res);
  const { error } = await sb
    .from("sc_friends")
    .delete()
    .or(`and(user_id.eq.${me},friend_id.eq.${target}),and(user_id.eq.${target},friend_id.eq.${me})`);
  if (error) throw error;
  res.json({ ok: true });
});
