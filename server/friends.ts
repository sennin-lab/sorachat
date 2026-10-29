import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { UUID } from "./messages.js";
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

const toInfo = (u: UserRow): FriendInfo => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  bio: u.bio ?? "",
  hasAvatar: Boolean(u.avatar_path),
  coverTheme: u.cover_theme ?? "green"
});

// 自分の友だちのID一覧（グループ作成・追加の判定や、検索結果の「追加済み」表示に使う）
export async function friendIdsOf(userId: string): Promise<Set<string>> {
  const { data, error } = await sb.from("sc_friends").select("friend_id").eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((row: { friend_id: string }) => row.friend_id));
}

friends.get("/friends", async (_req, res) => {
  const me = currentUserId(res);
  const ids = [...(await friendIdsOf(me))];
  if (!ids.length) {
    res.json([]);
    return;
  }
  const { data, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, bio, avatar_path, cover_theme")
    .in("id", ids)
    .order("display_name", { ascending: true });
  if (error) throw error;
  res.json((data ?? []).map((row) => toInfo(row as UserRow)));
});

const addSchema = z.object({ username: z.string().trim().toLowerCase().regex(USERNAME) });

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
  // 相互に1行ずつ保存する（既にある場合は何もしない）
  const { error: upsertError } = await sb.from("sc_friends").upsert(
    [
      { user_id: me, friend_id: other.id },
      { user_id: other.id, friend_id: me }
    ],
    { onConflict: "user_id,friend_id", ignoreDuplicates: true }
  );
  if (upsertError) throw upsertError;
  res.status(201).json(toInfo(other as UserRow));
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
