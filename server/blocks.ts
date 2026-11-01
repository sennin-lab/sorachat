import { Router } from "express";
import { currentUserId, requireAuth } from "./auth.js";
import { BOT_ID } from "./senninai.js";
import { UUID, blockedByMe } from "./messages.js";
import { sb } from "./supabase.js";

// ブロック。ブロックすると友だちとフレンド申請も消え、1対1のトークは送れなくなる（messages.ts の assertNotBlocked）
export const blocks = Router();
blocks.use("/blocks", requireAuth);

// ブロック中の相手の一覧（設定で解除できるように）
blocks.get("/blocks", async (_req, res) => {
  const ids = [...(await blockedByMe(currentUserId(res)))];
  if (!ids.length) {
    res.json([]);
    return;
  }
  const { data, error } = await sb.from("sc_users").select("id, username, display_name").in("id", ids);
  if (error) throw error;
  res.json(
    ((data ?? []) as { id: string; username: string; display_name: string }[]).map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name
    }))
  );
});

export async function blockUser(me: string, target: string): Promise<void> {
  const { error } = await sb.from("sc_blocks").upsert({ blocker_id: me, blocked_id: target }, { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true });
  if (error) throw error;
  // 友だちと申請は両方向とも消す
  const pair = (a: string, b: string) => `and(user_id.eq.${a},friend_id.eq.${b}),and(user_id.eq.${b},friend_id.eq.${a})`;
  const { error: friendError } = await sb.from("sc_friends").delete().or(pair(me, target));
  if (friendError) throw friendError;
  const reqPair = (a: string, b: string) => `and(from_id.eq.${a},to_id.eq.${b}),and(from_id.eq.${b},to_id.eq.${a})`;
  const { error: requestError } = await sb.from("sc_friend_requests").delete().or(reqPair(me, target));
  if (requestError) throw requestError;
}

blocks.post("/blocks/:userId", async (req, res) => {
  const target = String(req.params.userId);
  const me = currentUserId(res);
  if (!UUID.test(target) || target === me || target === BOT_ID) {
    res.status(400).json({ error: "この相手はブロックできません。" });
    return;
  }
  const { data } = await sb.from("sc_users").select("id").eq("id", target).maybeSingle();
  if (!data) {
    res.status(404).json({ error: "そのユーザーは見つかりません。" });
    return;
  }
  await blockUser(me, target);
  res.json({ ok: true });
});

blocks.delete("/blocks/:userId", async (req, res) => {
  const target = String(req.params.userId);
  if (!UUID.test(target)) {
    res.status(400).json({ error: "この相手は解除できません。" });
    return;
  }
  const { error } = await sb.from("sc_blocks").delete().eq("blocker_id", currentUserId(res)).eq("blocked_id", target);
  if (error) throw error;
  res.json({ ok: true });
});
