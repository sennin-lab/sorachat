// 仙人アカウントでソラチャットにログインした人への特典（1人1回・30pt）。
// ・同じ idempotency_key（sc-login-bonus-ユーザーID）で加算するので、何度試しても二重にはならない。
// ・ポイントの許可が無い・一時的に失敗したときは pending のまま残し、次のログインや残高の確認で再試行する。
// ・ログイン特典を使うには config.sennin.loginBonus（SENNIN_LOGIN_BONUS=on）が必要。
import { sb } from "./supabase.js";
import { adjustPoints, SenninError, withLock } from "./senninPoints.js";

export const LOGIN_BONUS_POINTS = 30;
// 失敗が続くときは、この回数までで自動の再試行をやめる（管理者が確かめる）
const MAX_ATTEMPTS = 5;

export async function grantLoginBonus(userId: string): Promise<"granted" | "already" | "pending"> {
  return withLock(`login-bonus:${userId}`, async () => {
    const { data, error } = await sb
      .from("sc_login_bonus")
      .select("status, attempts")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (data?.status === "granted") return "already";
    if (data && Number(data.attempts) >= MAX_ATTEMPTS) return "pending";

    if (!data) {
      const { error: insertError } = await sb.from("sc_login_bonus").insert({ user_id: userId, status: "pending" });
      // 同時に作られた場合は、そのまま続ける
      if (insertError && insertError.code !== "23505") throw insertError;
    }

    const attempts = Number(data?.attempts ?? 0) + 1;
    try {
      await adjustPoints(userId, {
        amount: LOGIN_BONUS_POINTS,
        reason: "ソラチャットへのログイン特典",
        idempotencyKey: `sc-login-bonus-${userId}`
      });
      await sb
        .from("sc_login_bonus")
        .update({ status: "granted", granted_at: new Date().toISOString(), last_error: null, attempts, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      return "granted";
    } catch (err) {
      const message = err instanceof SenninError ? err.message : "特典を付与できませんでした。";
      await sb
        .from("sc_login_bonus")
        .update({ attempts, last_error: message.slice(0, 200), updated_at: new Date().toISOString() })
        .eq("user_id", userId);
      throw err;
    }
  });
}

// 残高を見たときに、保留になっているログイン特典だけ再試行する（ログインしていない人には何もしない）
export async function retryPendingLoginBonus(userId: string): Promise<void> {
  const { data, error } = await sb.from("sc_login_bonus").select("status").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (data?.status !== "pending") return;
  await grantLoginBonus(userId).catch((err) => console.error("[bonus] ログイン特典の再試行に失敗:", err));
}
