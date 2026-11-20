// 友だち招待キャンペーン。
// ・招待コードは各ユーザーに1つ（sc_users.invite_code）。新しく登録する人が、招待コードを入れて登録する。
// ・招待した人・された人の両方に REFERRAL_POINTS を付ける（仙人アカウントのポイント）。
// ・同じ回線（IP）からの招待は禁止：招待した人の IP と同じ IP、またはその人が過去に招待した人と同じ IP は弾く。
// ・報酬は、仙人アカウントに連携していないなどで払えないときは pending のまま残す。
//   同じ idempotency_key（sc-referral-招待ID-side）で後から再試行するので、二重には付かない。
// ・キャンペーンを止めるには環境変数 REFERRAL_CAMPAIGN=off。
import { Router } from "express";
import { currentUserId, requireAuth } from "./auth.js";
import { withKeyedLock } from "./keyedLock.js";
import { adjustPoints, SenninError, withLock } from "./senninPoints.js";
import { sb } from "./supabase.js";

export const REFERRAL_POINTS = 2000;
export const REFERRAL_ON = (process.env.REFERRAL_CAMPAIGN ?? "on").toLowerCase() !== "off";

export class ReferralError extends Error {}

export function normalizeInviteCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export async function findInviterId(code: string): Promise<string | null> {
  const { data, error } = await sb.from("sc_users").select("id").eq("invite_code", code).maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

// 登録の前に確かめる。問題があれば ReferralError（利用者に見せる理由つき）
// 呼び出し側は inviterId ごとのロックの中で呼ぶ（同時に来ても、同じ回線からの2件目は必ず弾く）
export async function checkInvite(inviterId: string, ip: string): Promise<void> {
  const { data: inviter, error } = await sb.from("sc_users").select("signup_ip, last_ip").eq("id", inviterId).maybeSingle();
  if (error) throw error;
  if (!inviter) throw new ReferralError("招待コードが見つかりません。");
  const sameAsInviter = inviter.signup_ip === ip || inviter.last_ip === ip;
  const { data: earlier, error: earlierError } = await sb
    .from("sc_referrals")
    .select("id")
    .eq("inviter_id", inviterId)
    .eq("invitee_ip", ip)
    .limit(1);
  if (earlierError) throw earlierError;
  if (sameAsInviter || (earlier ?? []).length > 0) {
    throw new ReferralError("同じ回線（IPアドレス）からの招待は対象外です。招待コードを消して登録してください。");
  }
}

// 招待の記録を作り、両方の報酬を付ける（払えない分は pending のまま。ここでは待たせない）
export async function recordReferral(inviterId: string, inviteeId: string, inviterIp: string | null, inviteeIp: string): Promise<string> {
  const { data, error } = await sb
    .from("sc_referrals")
    .insert({ inviter_id: inviterId, invitee_id: inviteeId, inviter_ip: inviterIp, invitee_ip: inviteeIp })
    .select("id")
    .single();
  if (error) throw error;
  const id = data.id as string;
  void grantReferral(id).catch((err) => console.error("[referral] 招待の報酬を付与できませんでした（次回に再試行します）:", err));
  return id;
}

type Side = "inviter" | "invitee";

async function grantSide(referralId: string, userId: string, side: Side): Promise<void> {
  await withLock(`referral:${referralId}:${side}`, async () => {
    const column = side === "inviter" ? "inviter_status" : "invitee_status";
    const { data, error } = await sb
      .from("sc_referrals")
      .select("inviter_status, invitee_status")
      .eq("id", referralId)
      .maybeSingle();
    if (error) throw error;
    const status = side === "inviter" ? data?.inviter_status : data?.invitee_status;
    if (!data || status === "granted") return;
    try {
      await adjustPoints(userId, {
        amount: REFERRAL_POINTS,
        reason: "友だち招待キャンペーン",
        idempotencyKey: `sc-referral-${referralId}-${side}`
      });
      await sb
        .from("sc_referrals")
        .update({ [column]: "granted", last_error: null, updated_at: new Date().toISOString() })
        .eq("id", referralId);
    } catch (err) {
      const message = err instanceof SenninError ? err.message : "特典を付与できませんでした。";
      await sb
        .from("sc_referrals")
        .update({ last_error: message.slice(0, 200), updated_at: new Date().toISOString() })
        .eq("id", referralId);
    }
  });
}

async function grantReferral(referralId: string): Promise<void> {
  const { data, error } = await sb
    .from("sc_referrals")
    .select("inviter_id, invitee_id, inviter_status, invitee_status")
    .eq("id", referralId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  if (data.inviter_status !== "granted") await grantSide(referralId, data.inviter_id as string, "inviter");
  if (data.invitee_status !== "granted") await grantSide(referralId, data.invitee_id as string, "invitee");
}

// 払えていない報酬を再試行する（ログイン・連携のあと、残高を見たとき）。失敗しても止めない
export async function retryPendingReferrals(userId: string): Promise<void> {
  if (!REFERRAL_ON) return;
  try {
    const { data: asInviter, error: e1 } = await sb
      .from("sc_referrals")
      .select("id")
      .eq("inviter_id", userId)
      .eq("inviter_status", "pending");
    if (e1) throw e1;
    const { data: asInvitee, error: e2 } = await sb
      .from("sc_referrals")
      .select("id")
      .eq("invitee_id", userId)
      .eq("invitee_status", "pending");
    if (e2) throw e2;
    for (const row of (asInviter ?? []) as { id: string }[]) await grantSide(row.id, userId, "inviter");
    for (const row of (asInvitee ?? []) as { id: string }[]) await grantSide(row.id, userId, "invitee");
  } catch (err) {
    console.error("[referral] 保留中の招待報酬の再試行に失敗:", err);
  }
}

export const referral = Router();
referral.use("/referral", requireAuth);

// 自分の招待コードと、招待の人数・報酬の受け取り状況
referral.get("/referral", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const { data: user, error } = await sb.from("sc_users").select("invite_code").eq("id", me).maybeSingle();
  if (error) throw error;
  const { count: invited, error: invitedError } = await sb
    .from("sc_referrals")
    .select("id", { count: "exact", head: true })
    .eq("inviter_id", me);
  if (invitedError) throw invitedError;
  const { count: rewarded, error: rewardedError } = await sb
    .from("sc_referrals")
    .select("id", { count: "exact", head: true })
    .eq("inviter_id", me)
    .eq("inviter_status", "granted");
  if (rewardedError) throw rewardedError;
  void retryPendingReferrals(me);
  res.json({
    enabled: REFERRAL_ON,
    code: (user?.invite_code as string | undefined) ?? null,
    points: REFERRAL_POINTS,
    invitedCount: invited ?? 0,
    rewardedCount: rewarded ?? 0
  });
});
