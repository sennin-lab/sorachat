// オンライン対戦（拡張機能の中の対戦）。サブスク（1週間 200pt）・ランダムの対戦・友だちとの対戦の入口。
// 部屋の中身は battleRooms.ts（メモリ上）、サブスクの記録は sc_battle_subscriptions（DB）。
// 対戦を始められるのは、「拡張機能を買っている」「情報の許可をしている」「サブスクに入っている」人だけ。
import { Router } from "express";
import { currentUserId, requireAuth } from "./auth.js";
import { friendIdsOf } from "./friends.js";
import { isOnline, sendToUser } from "./hub.js";
import { UUID, blockedBetween } from "./messages.js";
import { adjustPoints, DEFINITE_FAILURE, isLinked, SenninError, withLock } from "./senninPoints.js";
import { BATTLE, autoRenewRequestId, checkAutoRenewRequest, checkInviteRequest, checkSize, checkSubscribeRequest, extendedExpiry, isSubscribed } from "./battleRules.js";
import {
  BattleError,
  createLobby,
  enqueueRandom,
  cancelQueue,
  isBusy,
  leaveRoom,
  pruneBattles,
  respondInvite,
  roomView,
  setBattleNotifier,
  startLobby
} from "./battleRooms.js";
import { canUseItem } from "./storeAccess.js";
import { loadWork, toStudioItem } from "./studioData.js";
import { sb } from "./supabase.js";

export const battle = Router();
battle.use("/battle", requireAuth);

// 部屋の知らせは、接続中の画面へ WebSocket で届ける
setBattleNotifier((userId, payload) => sendToUser(userId, payload));
// 古い待ち・放置された招待・終わった部屋の掃除（10秒ごと）
setInterval(() => pruneBattles(), 10_000).unref();

// ---- サブスク ----

type SubRow = { expiresAt: Date; autoRenew: boolean; lastRequestId: string };

async function readSub(userId: string): Promise<SubRow | null> {
  const { data, error } = await sb
    .from("sc_battle_subscriptions")
    .select("expires_at, auto_renew, last_request_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    expiresAt: new Date(String(data.expires_at)),
    autoRenew: Boolean(data.auto_renew),
    lastRequestId: String(data.last_request_id ?? "")
  };
}

export async function subscriptionView(userId: string) {
  const [linked, row] = await Promise.all([isLinked(userId), readSub(userId)]);
  const now = new Date();
  return {
    linked,
    subscribed: row ? isSubscribed(row.expiresAt, now) : false,
    expiresAt: row ? row.expiresAt.toISOString() : null,
    autoRenew: row ? row.autoRenew : false,
    price: BATTLE.subscriptionPoints,
    days: BATTLE.subscriptionDays
  };
}

// サブスクの支払い（1週間分）。同じ requestId の押し直しでは、二重に払わず・二重に延長しない
export async function purchaseSubscription(userId: string, requestId: string, auto: boolean) {
  return withLock(`battle-sub:${userId}`, async () => {
    const row = await readSub(userId);
    if (row && row.lastRequestId === requestId) {
      return { replayed: true, expiresAt: row.expiresAt };
    }
    if (!(await isLinked(userId))) {
      throw new BattleError(403, "not_linked", "ポイントで支払うには、仙人アカウントとの連携が必要です。");
    }
    const now = new Date();
    const next = extendedExpiry(row ? row.expiresAt : null, now);
    try {
      await adjustPoints(userId, {
        amount: -BATTLE.subscriptionPoints,
        reason: `オンライン対戦のサブスク（${BATTLE.subscriptionDays}日）${auto ? "・自動更新" : ""}`,
        idempotencyKey: `battle-sub-${requestId}`
      });
    } catch (error) {
      if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
        const status = error.code === "insufficient_points" ? 402 : error.code === "scope" || error.code === "not_linked" ? 403 : 409;
        throw new BattleError(status, error.code, error.message);
      }
      throw new BattleError(503, "unknown", "支払いの結果を確かめられませんでした。同じ申し込みで、もう一度お試しください。");
    }
    // 支払いが済んでから期限を延ばす。ここで失敗しても、同じ申し込みで押し直せば延長だけやり直せる
    const { error } = await sb.from("sc_battle_subscriptions").upsert(
      {
        user_id: userId,
        expires_at: next.toISOString(),
        auto_renew: row ? row.autoRenew : true,
        last_request_id: requestId,
        updated_at: now.toISOString()
      },
      { onConflict: "user_id" }
    );
    if (error) throw new BattleError(503, "unknown", "期限を更新できませんでした。同じ申し込みで、もう一度お試しください。");
    return { replayed: false, expiresAt: next };
  });
}

// 対戦を始める前に、サブスクの期限内か確かめる。切れていて自動更新がオンなら、ここで1回分を更新する
async function requireSubscription(userId: string): Promise<void> {
  const row = await readSub(userId);
  if (row && isSubscribed(row.expiresAt, new Date())) return;
  if (row && row.autoRenew) {
    try {
      await purchaseSubscription(userId, autoRenewRequestId(row.expiresAt), true);
      return;
    } catch (error) {
      if (error instanceof BattleError && error.code !== "unknown") {
        throw new BattleError(402, "not_subscribed", `自動更新できませんでした：${error.message}`);
      }
      throw error;
    }
  }
  throw new BattleError(402, "not_subscribed", `オンライン対戦は、サブスクに入ると使えます（1週間 ${BATTLE.subscriptionPoints}pt）。`);
}

// ---- 拡張機能の確認 ----

async function hasConsent(userId: string, workId: string): Promise<boolean> {
  const { data, error } = await sb.from("sc_extension_consents").select("user_id").eq("user_id", userId).eq("work_id", workId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// 拡張機能の対戦を始められるか（買っている・許可している）。拡張機能の名前を返す
async function requireExtension(userId: string, workId: string): Promise<{ name: string; item: ReturnType<typeof toStudioItem> }> {
  if (!UUID.test(workId)) throw new BattleError(404, "not_found", "拡張機能が見つかりません。");
  const work = await loadWork(workId);
  if (!work || work.kind !== "extension" || work.status === "removed") {
    throw new BattleError(404, "not_found", "拡張機能が見つかりません。");
  }
  const item = toStudioItem(work);
  if (work.creator_id !== userId && !(await canUseItem(userId, item))) {
    throw new BattleError(403, "not_owned", "この拡張機能はまだ購入していません。");
  }
  if (!(await hasConsent(userId, workId))) {
    throw new BattleError(403, "not_consented", "アカウント情報の許可がありません。拡張機能を開き直すと、確認が出ます。");
  }
  return { name: work.name, item };
}

async function usersById(ids: string[]) {
  if (!ids.length) return new Map<string, { name: string }>();
  const { data, error } = await sb.from("sc_users").select("id, display_name").in("id", ids);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [String(row.id), { name: String(row.display_name) }]));
}

function fail(res: import("express").Response, error: unknown) {
  if (error instanceof BattleError) {
    res.status(error.status).json({ ok: false, error: error.message, code: error.code });
    return;
  }
  throw error;
}

// ---- 公開の入口 ----

battle.get("/battle/subscription", async (_req, res) => {
  const me = currentUserId(res);
  try {
    res.json({ ok: true, ...(await subscriptionView(me)) });
  } catch (error) {
    fail(res, error);
  }
});

battle.post("/battle/subscription", async (req, res) => {
  const me = currentUserId(res);
  const checked = checkSubscribeRequest(req.body);
  if (!checked.ok) {
    res.status(400).json({ ok: false, error: checked.error, code: "invalid" });
    return;
  }
  try {
    await purchaseSubscription(me, checked.requestId, false);
    res.json({ ok: true, ...(await subscriptionView(me)) });
  } catch (error) {
    fail(res, error);
  }
});

battle.post("/battle/subscription/auto", async (req, res) => {
  const me = currentUserId(res);
  const checked = checkAutoRenewRequest(req.body);
  if (!checked.ok) {
    res.status(400).json({ ok: false, error: checked.error, code: "invalid" });
    return;
  }
  const row = await readSub(me);
  if (!row) {
    res.status(409).json({ ok: false, error: "サブスクに入っていないため、自動更新は設定できません。", code: "no_subscription" });
    return;
  }
  const { error } = await sb
    .from("sc_battle_subscriptions")
    .update({ auto_renew: checked.autoRenew, updated_at: new Date().toISOString() })
    .eq("user_id", me);
  if (error) throw error;
  res.json({ ok: true, ...(await subscriptionView(me)) });
});

// ランダムの対戦に入る（人数がそろったら、すぐ始まる。待つ間は WebSocket の「started」で知らせる）
battle.post("/battle/extensions/:id/queue", async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  const size = checkSize(req.body?.size);
  if (!size.ok) {
    res.status(400).json({ ok: false, error: size.error, code: "invalid" });
    return;
  }
  try {
    const work = await requireExtension(me, id);
    await requireSubscription(me);
    const name = (await usersById([me])).get(me)?.name ?? "";
    const result = enqueueRandom({ userId: me, name, gameId: id, gameName: work.name, size: size.size });
    res.json({ ok: true, ...result });
  } catch (error) {
    fail(res, error);
  }
});

battle.post("/battle/extensions/:id/queue/cancel", (req, res) => {
  const me = currentUserId(res);
  res.json({ ok: true, cancelled: cancelQueue(me) });
});

// 友だちを招待して、部屋を作る（招待された人が承諾し、主催者が開始する）
battle.post("/battle/extensions/:id/rooms", async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  const checked = checkInviteRequest(req.body);
  if (!checked.ok) {
    res.status(400).json({ ok: false, error: checked.error, code: "invalid" });
    return;
  }
  try {
    const work = await requireExtension(me, id);
    await requireSubscription(me);
    const friends = await friendIdsOf(me);
    const names = await usersById([me, ...checked.inviteIds]);
    const reasons: string[] = [];
    const invitees: { userId: string; name: string }[] = [];
    for (const uid of checked.inviteIds) {
      const name = names.get(uid)?.name;
      if (!name) {
        reasons.push("見つからない人がいます");
        continue;
      }
      if (uid === me) continue;
      if (!friends.has(uid) || (await blockedBetween(me, uid))) {
        reasons.push(`${name}さんは、友だちではありません`);
        continue;
      }
      if (!isOnline(uid)) {
        reasons.push(`${name}さんは、オンラインではありません`);
        continue;
      }
      if (isBusy(uid)) {
        reasons.push(`${name}さんは、ほかの対戦の中です`);
        continue;
      }
      if (!(await hasConsent(uid, id)) || !(await canUseItem(uid, work.item))) {
        reasons.push(`${name}さんは、この拡張機能で遊べる状態ではありません`);
        continue;
      }
      const sub = await readSub(uid);
      if (!sub || !isSubscribed(sub.expiresAt, new Date())) {
        reasons.push(`${name}さんは、サブスクに入っていません`);
        continue;
      }
      invitees.push({ userId: uid, name });
    }
    if (reasons.length) {
      res.status(409).json({ ok: false, error: `招待できません：${reasons.join("、")}。`, code: "invitee_unavailable" });
      return;
    }
    if (invitees.length === 0) {
      res.status(400).json({ ok: false, error: "招待する友だちを選んでください。", code: "invalid" });
      return;
    }
    const hostName = names.get(me)?.name ?? "";
    const room = createLobby({ hostId: me, hostName, gameId: id, gameName: work.name, invitees });
    res.json({ ok: true, room: roomView(me, room.id) });
  } catch (error) {
    fail(res, error);
  }
});

// 招待への返事・開始・退出
battle.post("/battle/rooms/:roomId/:action", async (req, res) => {
  const me = currentUserId(res);
  const roomId = String(req.params.roomId);
  const action = String(req.params.action);
  if (!UUID.test(roomId)) {
    res.status(404).json({ ok: false, error: "部屋が見つかりません。", code: "not_found" });
    return;
  }
  try {
    if (action === "accept") {
      const view = roomView(me, roomId);
      if (!view) throw new BattleError(404, "not_found", "この招待は見つかりません。");
      await requireExtension(me, view.gameId);
      await requireSubscription(me);
      respondInvite(me, roomId, true);
    } else if (action === "decline") {
      respondInvite(me, roomId, false);
    } else if (action === "start") {
      startLobby(me, roomId);
    } else if (action === "leave") {
      leaveRoom(me, roomId);
    } else {
      res.status(404).json({ ok: false, error: "見つかりません。", code: "not_found" });
      return;
    }
    res.json({ ok: true, room: roomView(me, roomId) });
  } catch (error) {
    fail(res, error);
  }
});
