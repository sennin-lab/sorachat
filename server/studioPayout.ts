// 作者への支払い。購入されるたびに、購入額から株主配当（SenninBank の投資家へ配る分）を差し引いて、作者のポイントに加算する。
// 配当は作者が投資を受けているときだけ差し引く（投資が無ければ、これまでどおり全額）。手数料は運営には入らない。
// ・作者が仙人アカウントを連携していない、または権限がない間は pending のまま残し、連携後にまとめて払う。
// ・支払いごとに idempotency_key（sc-pay-支払いID）を付けるので、再送しても二重に払わない。
// ・払えない理由が「入力の誤り（invalid）」のときだけ failed にして、管理者が確認する（管理者の再送で pending に戻せる）。
import { randomUUID } from "node:crypto";
import { sb } from "./supabase.js";
import { adjustPoints, SenninError, withLock } from "./senninPoints.js";
import { bankRates } from "./bankRules.js";

// 購入の記録に続けて、作者への支払いを作って払おうとする（失敗しても購入は成立している。あとで再送される）
// 支払いの元は、ストアの購入（purchaseId）か、拡張機能の中の支払い（chargeId）のどちらか1つ。
export async function recordSale(args: { creatorId: string; workId: string; purchaseId?: string; chargeId?: string; amount: number }) {
  if (Boolean(args.purchaseId) === Boolean(args.chargeId)) {
    throw new Error("支払いの元は、購入か拡張機能の支払いのどちらか1つにしてください。");
  }
  // 配当の計算・支払いの記録・投資家への配当を、1つの DB の関数（supabase/schema_v42.sql）で行う。
  // 同じ購入（または同じ拡張機能の支払い）は、関数の中で二重に記録しない。
  const id = randomUUID();
  const { data, error } = await sb.rpc("sc_bank_record_sale", {
    p_payout: id,
    p_creator: args.creatorId,
    p_work: args.workId,
    p_purchase: args.purchaseId ?? null,
    p_charge: args.chargeId ?? null,
    p_gross: args.amount,
    p_dividend_rate: bankRates().dividendRate,
    p_daily_rate: bankRates().dailyRate
  });
  if (error) throw error;
  const created = Boolean((data as { created?: boolean } | null)?.created);
  if (!created) return;
  await payOne(id).catch((error) => console.error("[studio] 作者への支払いに失敗（あとで再送されます）:", error));
}

async function payOne(payoutId: string): Promise<void> {
  const { data, error } = await sb
    .from("sc_studio_payouts")
    .select("id, creator_id, work_id, amount, status, attempts")
    .eq("id", payoutId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "pending") return;

  const { data: work } = await sb.from("sc_studio_works").select("name").eq("id", data.work_id as string).maybeSingle();
  const workName = (work?.name as string | undefined) ?? "作品";
  const attempts = Number(data.attempts) + 1;
  try {
    const result = await adjustPoints(data.creator_id as string, {
      amount: Number(data.amount),
      reason: `ソラチャット作品の売上：${workName}`.slice(0, 100),
      idempotencyKey: `sc-pay-${payoutId}`
    });
    await sb
      .from("sc_studio_payouts")
      .update({ status: "paid", attempts, last_error: null, sennin_ledger_id: result.ledgerId, updated_at: new Date().toISOString() })
      .eq("id", payoutId);
  } catch (error) {
    const message = error instanceof SenninError ? error.message : "支払いに失敗しました。";
    const giveUp = error instanceof SenninError && error.code === "invalid";
    await sb
      .from("sc_studio_payouts")
      .update({ status: giveUp ? "failed" : "pending", attempts, last_error: message.slice(0, 200), updated_at: new Date().toISOString() })
      .eq("id", payoutId);
    // 連携されていない・権限がないときは、残りも同じ理由で払えないので止める
    if (error instanceof SenninError && !giveUp) throw error;
  }
}

// 作者の保留中の支払いをまとめて払う（連携したとき・作者が画面を開いたとき・管理者の再送）
export async function retryCreatorPayouts(creatorId: string): Promise<void> {
  await withLock(`payout:${creatorId}`, async () => {
    const { data, error } = await sb
      .from("sc_studio_payouts")
      .select("id")
      .eq("creator_id", creatorId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw error;
    for (const row of data ?? []) {
      try {
        await payOne(row.id as string);
      } catch {
        // 連携・権限の問題なら、この人の残りは次の機会に払う
        break;
      }
    }
  });
}

// 管理者の再送。failed も pending に戻して払い直す
export async function retryPayout(payoutId: string): Promise<void> {
  const { data, error } = await sb.from("sc_studio_payouts").select("creator_id, status").eq("id", payoutId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("支払いが見つかりません。");
  if (data.status === "paid") throw new Error("この支払いは済んでいます。");
  await withLock(`payout:${data.creator_id as string}`, async () => {
    await sb.from("sc_studio_payouts").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", payoutId);
    await payOne(payoutId);
  });
  // 払えたかを確かめてから返す（失敗のままなら、理由を管理者に返す）
  const { data: after } = await sb.from("sc_studio_payouts").select("status, last_error").eq("id", payoutId).maybeSingle();
  if (after?.status !== "paid") throw new Error(`支払いできませんでした（${(after?.last_error as string | null) ?? "理由不明"}）`);
}
