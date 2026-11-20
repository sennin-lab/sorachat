// 宝くじ。管理者が作り、利用者は 1券 1000pt で買う。
//
// ・券の番号は購入の時に決まる（numbers）。購入は操作ID（requestId）ごとに1回だけ行われる。
// ・購入の支払いは仙人アカウントのポイント（adjustPoints）。idempotency_key（lottery-buy-操作ID）で、再送しても二重には引かない。
//   確かに失敗したとき（ポイント不足など）は購入を failed にする。確かめられないときは pending のまま残し、同じ操作IDで押し直すと確かめてから進む。
// ・販売は発表の時点で終わる。発表の前に、確かめられていない購入はすべて片付ける（販売の後に券が増えないように、宝くじごとのロックで順番を揃える）。
// ・発表は管理者が行う。当選番号はサーバーで引き、当選者を sc_lottery_winners に記録する。
//   番号は一桁ずつ公開する（公開の済んでいない桁は、サーバーが返さない）。全部公開されたら結果確定。
// ・賞金は結果確定のあと、仙人アカウントへ idempotency_key（lottery-prize-賞金ID）で加算する。失敗したものは次の機会に再試行する。
import { Router, type Response } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { requireAdmin } from "./admin.js";
import { sb } from "./supabase.js";
import { adjustPoints, DEFINITE_FAILURE, SenninError, withLock } from "./senninPoints.js";
import { LOTTERY, drawNumber, finishesAtMs, isCalendarDate, pickWinningNumber, revealedCount, statusOf, tierOf, todayJst, validatePrizes } from "./lotteryRules.js";

export const lottery = Router();
export const lotteryAdmin = Router();
lottery.use("/lottery", requireAuth);
lotteryAdmin.use("/admin/lotteries", requireAdmin);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 連打の防止（1人あたり、時間枠の中で max 回まで）
const hits = new Map<string, number[]>();
function allow(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

class LotteryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendError(res: Response, error: unknown) {
  if (error instanceof LotteryError) {
    res.status(error.status).json({ ok: false, error: error.message });
    return;
  }
  if (error instanceof SenninError) {
    const status = error.code === "not_linked" || error.code === "scope" ? 403 : error.code === "insufficient_points" ? 409 : 503;
    res.status(status).json({ ok: false, error: error.message, code: error.code });
    return;
  }
  console.error("[lottery] 宝くじの処理でエラー:", error);
  res.status(500).json({ ok: false, error: "宝くじの処理でエラーが発生しました。時間をおいてお試しください。" });
}

// 空の一覧で `in` を使うと問い合わせが壊れるので、どの ID にも一致しないダミーを入れる
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const nonEmpty = (ids: string[]) => (ids.length ? ids : [NIL_ID]);

type LotRow = {
  id: string;
  name: string;
  digits: number;
  tier_prizes: number[];
  announce_on: string;
  announced_at: string | null;
  winning_number: string | null;
  created_at: string;
};
type PurchaseRow = { id: string; lottery_id: string; user_id: string; quantity: number; amount: number; status: "pending" | "done" | "failed"; numbers: string[] };
type WinnerRow = { id: number; lottery_id: string; purchase_id: string; idx: number; user_id: string; tier: number; number: string; prize: number; status: "pending" | "paid" };

const LOT_COLUMNS = "id, name, digits, tier_prizes, announce_on, announced_at, winning_number, created_at";

async function loadLottery(id: string): Promise<LotRow | null> {
  const { data, error } = await sb.from("sc_lotteries").select(LOT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as LotRow | null) ?? null;
}

async function loadPurchase(id: string): Promise<PurchaseRow | null> {
  const { data, error } = await sb
    .from("sc_lottery_purchases")
    .select("id, lottery_id, user_id, quantity, amount, status, numbers")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as PurchaseRow | null) ?? null;
}

async function setPurchaseStatus(id: string, status: "done" | "failed") {
  const { error } = await sb.from("sc_lottery_purchases").update({ status }).eq("id", id);
  if (error) throw error;
}

// 途中の購入を片付ける。open のときは購入を完了し、販売が終わっていたら支払いを返して failed にする。
// 戻り値は最終的な状態。確かめられない失敗は例外のまま（pending が残り、次に押し直すと続きから進む）。
async function settlePending(lot: LotRow, p: PurchaseRow, open: boolean): Promise<"done" | "failed"> {
  const title = `宝くじ「${lot.name}」`;
  try {
    await adjustPoints(p.user_id, { amount: -p.amount, reason: `${title}の購入`, idempotencyKey: `lottery-buy-${p.id}` });
  } catch (error) {
    if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
      await setPurchaseStatus(p.id, "failed");
      return "failed";
    }
    throw error;
  }
  if (open) {
    await setPurchaseStatus(p.id, "done");
    return "done";
  }
  // 販売が終わったあとに確かめられた購入は、支払いを返して取り消す
  await adjustPoints(p.user_id, { amount: p.amount, reason: `${title}の購入の取り消し（販売終了）`, idempotencyKey: `lottery-refund-${p.id}` });
  await setPurchaseStatus(p.id, "failed");
  return "failed";
}

// 賞金の払い出し（同じ宝くじの払い出しが重ならないように、実行中の宝くじを覚えておく）
const paying = new Set<string>();
export async function payWinners(lotteryId: string): Promise<void> {
  if (paying.has(lotteryId)) return;
  paying.add(lotteryId);
  try {
    const lot = await loadLottery(lotteryId);
    if (!lot || lot.announced_at === null || statusOf(Date.parse(lot.announced_at), lot.digits, Date.now()) !== "done") return;
    const { data, error } = await sb
      .from("sc_lottery_winners")
      .select("id, user_id, tier, prize")
      .eq("lottery_id", lotteryId)
      .eq("status", "pending");
    if (error) throw error;
    for (const w of (data ?? []) as { id: number; user_id: string; tier: number; prize: number }[]) {
      try {
        await adjustPoints(w.user_id, {
          amount: w.prize,
          reason: `宝くじ「${lot.name}」の${w.tier}等の当選`,
          idempotencyKey: `lottery-prize-${w.id}`
        });
        const { error: updateError } = await sb
          .from("sc_lottery_winners")
          .update({ status: "paid", paid_at: new Date().toISOString() })
          .eq("id", w.id);
        if (updateError) throw updateError;
      } catch (error) {
        // 払い出しは同じ賞金IDで再試行できる（二重には入らない）
        console.error(`[lottery] 賞金の払い出しに失敗（次の機会に再試行）: ${w.id}`, error);
      }
    }
  } catch (error) {
    console.error("[lottery] 賞金の払い出しを確かめられませんでした:", error);
  } finally {
    paying.delete(lotteryId);
  }
}

// 画面に出す形（利用者・管理者で同じ形。管理者だけ払い出しの状況が増える）
type View = ReturnType<typeof viewOf>;
function viewOf(
  lot: LotRow,
  now: number,
  sold: number,
  mine: string[],
  winners: { tier: number; number: string; prize: number; name: string; userId: string; status: string }[],
  myWinCount: number,
  pendingPayouts: number,
  today: string
) {
  const announcedMs = lot.announced_at ? Date.parse(lot.announced_at) : null;
  const status = statusOf(announcedMs, lot.digits, now);
  const shown = announcedMs !== null && lot.winning_number ? revealedCount(announcedMs, now, lot.digits) : 0;
  return {
    id: lot.id,
    name: lot.name,
    ticketPrice: LOTTERY.ticketPrice,
    digits: lot.digits,
    prizes: lot.tier_prizes.map((pt, i) => ({ tier: i + 1, pt })),
    announceOn: lot.announce_on,
    status,
    canAnnounce: status === "selling" && lot.announce_on <= today && sold > 0,
    // 公開済みの桁だけ（残りは画面で回る数字にする。実際の数字は送らない）
    revealed: announcedMs !== null && lot.winning_number ? lot.winning_number.slice(0, shown) : "",
    finishesAt: announcedMs !== null ? new Date(finishesAtMs(announcedMs, lot.digits)).toISOString() : null,
    // 結果が確定してから、当選番号と当選者を出す
    winningNumber: status === "done" ? lot.winning_number : null,
    winners: status === "done" ? winners.map((w) => ({ tier: w.tier, number: w.number, prize: w.prize, name: w.name, userId: w.userId })) : null,
    sold,
    myTickets: mine,
    myWinCount: status === "done" ? myWinCount : 0,
    pendingPayouts
  };
}

// 宝くじの一覧を画面用に組み立てる。me が null のときは管理者向け（券の中身は見せず、払い出しの状況を出す）
async function buildViews(lots: LotRow[], me: string | null) {
  if (lots.length === 0) return [];
  const ids = lots.map((l) => l.id);
  const [purchaseRes, winnerRes] = await Promise.all([
    sb.from("sc_lottery_purchases").select("id, lottery_id, user_id, quantity, amount, status, numbers").in("lottery_id", ids).eq("status", "done"),
    sb.from("sc_lottery_winners").select("id, lottery_id, purchase_id, idx, user_id, tier, number, prize, status").in("lottery_id", ids)
  ]);
  if (purchaseRes.error) throw purchaseRes.error;
  if (winnerRes.error) throw winnerRes.error;
  const purchases = (purchaseRes.data ?? []) as PurchaseRow[];
  const winners = (winnerRes.data ?? []) as WinnerRow[];

  const userIds = [...new Set(winners.map((w) => String(w.user_id)))];
  const userRes = await sb.from("sc_users").select("id, display_name").in("id", nonEmpty(userIds));
  if (userRes.error) throw userRes.error;
  const nameOf = new Map(((userRes.data ?? []) as { id: string; display_name: string }[]).map((u) => [String(u.id), String(u.display_name)]));

  const now = Date.now();
  const today = todayJst(now);
  const views: View[] = [];
  for (const lot of lots) {
    const own = purchases.filter((p) => p.lottery_id === lot.id);
    const sold = own.reduce((sum, p) => sum + p.quantity, 0);
    const mine = me ? own.filter((p) => p.user_id === me).flatMap((p) => p.numbers) : [];
    const lotWinners = winners.filter((w) => w.lottery_id === lot.id);
    const pendingPayouts = lotWinners.filter((w) => w.status === "pending").length;
    const shownWinners = lotWinners
      .sort((a, b) => a.tier - b.tier || a.idx - b.idx)
      .map((w) => ({ tier: w.tier, number: w.number, prize: w.prize, name: nameOf.get(String(w.user_id)) ?? "ユーザー", userId: String(w.user_id), status: w.status }));
    const myWinCount = me ? lotWinners.filter((w) => w.user_id === me).length : 0;
    const view = viewOf(lot, now, sold, mine, shownWinners, myWinCount, pendingPayouts, today);
    // 結果が確定したのに払い出しが残っていれば、続きを進める（画面の表示は待たせない）
    if (view.status === "done" && pendingPayouts > 0) void payWinners(lot.id);
    views.push(view);
  }
  return views;
}

// ---- 利用者向け ----

// 宝くじの一覧（新しいものから。直近20件）
lottery.get("/lottery/state", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  try {
    const { data, error } = await sb.from("sc_lotteries").select(LOT_COLUMNS).order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    const lots = (data ?? []) as LotRow[];
    const views = await buildViews(lots, me);
    res.json({ ok: true, ticketPrice: LOTTERY.ticketPrice, maxPerRequest: LOTTERY.maxQuantityPerRequest, maxPerUser: LOTTERY.maxTicketsPerUser, lotteries: views });
  } catch (error) {
    sendError(res, error);
  }
});

const buyBody = z.object({
  requestId: z.string().regex(UUID),
  quantity: z.number().int().min(1).max(LOTTERY.maxQuantityPerRequest)
});

// 券を買う（1券 1000pt）。同じ操作IDで再送しても、二重には買えない
lottery.post("/lottery/:id/buy", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ ok: false, error: "見つかりません。" });
    return;
  }
  const parsed = buyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "枚数か操作IDを確かめてください。" });
    return;
  }
  if (!allow(`lottery:${me}`, 20, 60_000)) {
    res.status(429).json({ ok: false, error: "操作が多すぎます。少し待ってからお試しください。" });
    return;
  }
  const { requestId, quantity } = parsed.data;
  try {
    await withLock(`lottery:${id}`, async () => {
      const lot = await loadLottery(id);
      if (!lot) throw new LotteryError(404, "見つかりません。");
      const open = statusOf(lot.announced_at ? Date.parse(lot.announced_at) : null, lot.digits, Date.now()) === "selling";

      let p = await loadPurchase(requestId);
      if (!p) {
        if (!open) throw new LotteryError(409, "この宝くじは販売を終了しています。");
        // 1人が持てる枚数の上限（取り消されたものは数えない）
        const { data, error } = await sb
          .from("sc_lottery_purchases")
          .select("quantity")
          .eq("lottery_id", id)
          .eq("user_id", me)
          .neq("status", "failed");
        if (error) throw error;
        const owned = ((data ?? []) as { quantity: number }[]).reduce((sum, r) => sum + r.quantity, 0);
        if (owned + quantity > LOTTERY.maxTicketsPerUser) {
          throw new LotteryError(400, `この宝くじは1人${LOTTERY.maxTicketsPerUser}枚までです（あと${Math.max(LOTTERY.maxTicketsPerUser - owned, 0)}枚）。`);
        }
        // 券の番号は、購入の記録と一緒に決めて残す（押し直しても同じ番号になる）
        const numbers = Array.from({ length: quantity }, () => drawNumber(lot.digits));
        const { error: insertError } = await sb.from("sc_lottery_purchases").insert({
          id: requestId,
          lottery_id: id,
          user_id: me,
          quantity,
          amount: quantity * LOTTERY.ticketPrice,
          status: "pending",
          numbers
        });
        if (insertError && insertError.code !== "23505") throw insertError;
        p = await loadPurchase(requestId);
      }
      if (!p || p.user_id !== me || p.lottery_id !== id) throw new LotteryError(400, "この操作IDは使えません。");
      if (p.status === "failed") throw new LotteryError(409, "この購入は取り消されました。ポイントは減っていません。");
      if (p.status === "pending") {
        const outcome = await settlePending(lot, p, open);
        if (outcome === "failed") {
          throw new LotteryError(409, open ? "ポイントが足りないため、購入できませんでした。" : "販売が終了したため、購入は取り消されました。");
        }
      }
    });
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

// ---- 管理者向け ----

const createBody = z.object({
  name: z.string().trim().min(1).max(LOTTERY.nameMax),
  digits: z.number().int().min(LOTTERY.minDigits).max(LOTTERY.maxDigits),
  // 1等（最高金額）から順に、各等の賞金（pt）
  prizes: z.array(z.number()).min(1).max(LOTTERY.maxTiers),
  // 結果発表日（日本時間の日付 YYYY-MM-DD）
  announceOn: z.string()
});

lotteryAdmin.get("/admin/lotteries", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { data, error } = await sb.from("sc_lotteries").select(LOT_COLUMNS).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ ok: true, today: todayJst(Date.now()), limits: { digits: [LOTTERY.minDigits, LOTTERY.maxDigits], tiers: LOTTERY.maxTiers, maxPrize: LOTTERY.maxPrize, nameMax: LOTTERY.nameMax, ticketPrice: LOTTERY.ticketPrice }, lotteries: await buildViews((data ?? []) as LotRow[], null) });
  } catch (error) {
    sendError(res, error);
  }
});

lotteryAdmin.post("/admin/lotteries", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "入力内容を確かめてください。" });
    return;
  }
  const { name, digits, prizes, announceOn } = parsed.data;
  const now = Date.now();
  if (!isCalendarDate(announceOn)) {
    res.status(400).json({ ok: false, error: "結果発表日を正しく入れてください。" });
    return;
  }
  if (announceOn < todayJst(now)) {
    res.status(400).json({ ok: false, error: "結果発表日は今日以降にしてください。" });
    return;
  }
  const problem = validatePrizes(digits, prizes);
  if (problem) {
    res.status(400).json({ ok: false, error: problem });
    return;
  }
  try {
    const { error } = await sb.from("sc_lotteries").insert({ name, digits, tier_prizes: prizes, announce_on: announceOn });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

// 発表：当選番号を引き、当選者を記録する。番号は一桁ずつ公開され、全部見せ終わると結果確定（賞金の払い出しも、そのあとに行う）
lotteryAdmin.post("/admin/lotteries/:id/announce", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ ok: false, error: "見つかりません。" });
    return;
  }
  try {
    const announcedAt = await withLock(`lottery:${id}`, async () => {
      const lot = await loadLottery(id);
      if (!lot) throw new LotteryError(404, "見つかりません。");
      if (lot.announced_at) throw new LotteryError(409, "この宝くじはもう発表しています。");
      if (todayJst(Date.now()) < lot.announce_on) {
        throw new LotteryError(400, `結果発表日（${lot.announce_on}）になると発表できます。`);
      }

      // 販売を閉じる前に、確かめられていない購入をすべて片付ける
      const { data: pendings, error: pendingError } = await sb
        .from("sc_lottery_purchases")
        .select("id, lottery_id, user_id, quantity, amount, status, numbers")
        .eq("lottery_id", id)
        .eq("status", "pending");
      if (pendingError) throw pendingError;
      for (const p of (pendings ?? []) as PurchaseRow[]) {
        await settlePending(lot, p, false);
      }

      const { data: bought, error: boughtError } = await sb
        .from("sc_lottery_purchases")
        .select("id, user_id, numbers")
        .eq("lottery_id", id)
        .eq("status", "done");
      if (boughtError) throw boughtError;

      // 当選番号は、売れた券の中から1枚を選んで決める（必ず1等の当選者が出る）。券が1枚もなければ発表できない
      const soldTickets = ((bought ?? []) as { numbers: string[] }[]).flatMap((p) => p.numbers);
      const winning = pickWinningNumber(soldTickets);
      if (winning === null) throw new LotteryError(400, "券が1枚も売れていないため、発表できません。");
      const rows: Omit<WinnerRow, "id" | "status">[] = [];
      for (const p of (bought ?? []) as { id: string; user_id: string; numbers: string[] }[]) {
        p.numbers.forEach((number, idx) => {
          const tier = tierOf(number, winning, lot.tier_prizes.length);
          if (tier === null) return;
          rows.push({ lottery_id: id, purchase_id: p.id, idx, user_id: p.user_id, tier, number, prize: lot.tier_prizes[tier - 1] });
        });
      }
      // 途中で止まった発表をやり直せるように、まだ払い出していない当選者の記録は作り直す
      const { error: clearError } = await sb.from("sc_lottery_winners").delete().eq("lottery_id", id);
      if (clearError) throw clearError;
      if (rows.length) {
        const { error: insertError } = await sb.from("sc_lottery_winners").insert(rows);
        if (insertError) throw insertError;
      }

      const nowIso = new Date().toISOString();
      const { data: updated, error: updateError } = await sb
        .from("sc_lotteries")
        .update({ announced_at: nowIso, winning_number: winning })
        .eq("id", id)
        .is("announced_at", null)
        .select("id");
      if (updateError) throw updateError;
      if (!updated?.length) throw new LotteryError(409, "この宝くじはもう発表しています。");
      return nowIso;
    });

    // 全部の桁を見せ終わったら、賞金を払い出す（サーバーが再起動していても、画面を開いたときに続きを行う）
    const announcedMs = Date.parse(announcedAt);
    const lot = await loadLottery(id);
    const delay = lot ? finishesAtMs(announcedMs, lot.digits) - Date.now() + 500 : 0;
    setTimeout(() => void payWinners(id), Math.max(delay, 0));
    res.json({ ok: true, announcedAt });
  } catch (error) {
    sendError(res, error);
  }
});
