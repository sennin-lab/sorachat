// SenninBank（銀行）の API。
// ・PT を預けると、預金に利息がつく。開発者（作者）に投資すると、その人の作品の売上から配当を受け取れる。
// ・預け入れ・引き出しだけが仙人アカウントのポイントに触る。idempotency_key（bank-dep-操作ID / bank-wd-操作ID）で、再送しても二重に動かない。
//   途中で止まった操作（pending）は、次に銀行を開いたとき・操作したときに同じキーで最後まで進める。
// ・利息・配当・投資は銀行の中だけで動く。残高の計算と記録は DB の関数（supabase/schema_v42.sql）で1つのまとまりとして行う。
import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { sb } from "./supabase.js";
import { adjustPoints, DEFINITE_FAILURE, isLinked, SenninError, withLock } from "./senninPoints.js";
import { BANK_LIMITS, bankRates, dividendPool, dividendShare, interestSince } from "./bankRules.js";

export const bank = Router();
bank.use("/bank", requireAuth);

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

class BankError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type OpRow = { id: string; kind: "deposit" | "withdraw"; amount: number; status: "pending" | "done" | "failed" };

const num = (value: unknown) => Number(value ?? 0);

// 空の一覧で `in` を使うと問い合わせが壊れるので、どの ID にも一致しないダミーを入れる
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const nonEmpty = (ids: string[]) => (ids.length ? ids : [NIL_ID]);

function sendError(res: Response, error: unknown) {
  if (error instanceof BankError) {
    res.status(error.status).json({ ok: false, error: error.message });
    return;
  }
  if (error instanceof SenninError) {
    const status =
      error.code === "not_linked" || error.code === "scope"
        ? 403
        : error.code === "insufficient_points"
          ? 409
          : error.code === "daily_limit"
            ? 429
            : error.code === "invalid"
              ? 400
              : 503;
    res.status(status).json({ ok: false, error: error.message, code: error.code });
    return;
  }
  console.error("[bank] 銀行の処理でエラー:", error);
  res.status(500).json({ ok: false, error: "銀行の処理でエラーが発生しました。時間をおいてお試しください。" });
}

// 作者として投資を受け付けられるか（公開中の作品があり、停止されていない）
async function isInvestable(creatorId: string): Promise<boolean> {
  const { data: suspended, error: suspendedError } = await sb
    .from("sc_studio_creators")
    .select("suspended")
    .eq("user_id", creatorId)
    .maybeSingle();
  if (suspendedError) throw suspendedError;
  if (suspended?.suspended) return false;
  const { data, error } = await sb
    .from("sc_studio_works")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("status", "published")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function readOp(userId: string, opId: string): Promise<OpRow | null> {
  const { data, error } = await sb
    .from("sc_bank_ops")
    .select("id, kind, amount, status")
    .eq("id", opId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as OpRow | null) ?? null;
}

// 途中（pending）の操作を、同じ idempotency_key で最後まで進める。
// 仙人アカウント側で確実に失敗した預け入れは failed に、引き出しは残高へ戻して failed にする。
// 結果が分からない失敗（通信の途切れなど）は pending のまま残し、次の機会にもう一度送る。
async function resolveOp(userId: string, op: OpRow): Promise<void> {
  const { dailyRate } = bankRates();
  if (op.kind === "deposit") {
    try {
      await adjustPoints(userId, {
        amount: -op.amount,
        reason: "SenninBank：預け入れ",
        idempotencyKey: `sc-bank-dep-${op.id}`
      });
    } catch (error) {
      if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
        await sb
          .from("sc_bank_ops")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", op.id)
          .eq("status", "pending");
      }
      throw error;
    }
    const { error } = await sb.rpc("sc_bank_settle_deposit", { p_op: op.id, p_daily_rate: dailyRate });
    if (error) throw error;
    return;
  }

  try {
    await adjustPoints(userId, {
      amount: op.amount,
      reason: "SenninBank：引き出し",
      idempotencyKey: `sc-bank-wd-${op.id}`
    });
  } catch (error) {
    if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
      const { error: finishError } = await sb.rpc("sc_bank_withdraw_finish", {
        p_op: op.id,
        p_ok: false,
        p_daily_rate: dailyRate
      });
      if (finishError) throw finishError;
    }
    throw error;
  }
  const { error } = await sb.rpc("sc_bank_withdraw_finish", { p_op: op.id, p_ok: true, p_daily_rate: dailyRate });
  if (error) throw error;
}

// 途中で止まった操作を全部進める（ユーザーごとのロックの中で呼ぶ）
async function resumePending(userId: string): Promise<void> {
  const { data, error } = await sb
    .from("sc_bank_ops")
    .select("id, kind, amount, status")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw error;
  for (const op of (data ?? []) as OpRow[]) {
    await resolveOp(userId, op);
  }
}

// 預け入れ：操作を pending で作り、ポイントを減らし、銀行の元本に入れる
async function deposit(userId: string, opId: string, amount: number) {
  const existing = await readOp(userId, opId);
  if (!existing) {
    const { error } = await sb
      .from("sc_bank_ops")
      .insert({ id: opId, user_id: userId, kind: "deposit", amount, status: "pending" });
    if (error && error.code !== "23505") throw error;
  }
  const op = (await readOp(userId, opId)) ?? null;
  if (!op) throw new BankError(500, "操作の記録を作れませんでした。");
  if (op.status === "pending") await resolveOp(userId, op);
  const after = await readOp(userId, opId);
  if (after?.status === "failed") {
    throw new BankError(409, "預け入れできませんでした。ポイントは減っていません。");
  }
  return { ok: true as const, status: after?.status ?? "done" };
}

// 引き出し：銀行から先に減らし（pending）、ポイントを返す。完了したら done
async function withdraw(userId: string, opId: string, amount: number) {
  const existing = await readOp(userId, opId);
  if (!existing) {
    const { data, error } = await sb.rpc("sc_bank_withdraw_begin", {
      p_op: opId,
      p_user: userId,
      p_amount: amount,
      p_daily_rate: bankRates().dailyRate
    });
    if (error) throw error;
    if (data === "insufficient") throw new BankError(409, "預金が足りません。");
  }
  const op = await readOp(userId, opId);
  if (!op) throw new BankError(500, "操作の記録を作れませんでした。");
  if (op.status === "pending") await resolveOp(userId, op);
  const after = await readOp(userId, opId);
  if (after?.status === "failed") {
    throw new BankError(409, "引き出しできませんでした。預金は元に戻しています。");
  }
  return { ok: true as const, status: after?.status ?? "done" };
}

const opBody = z.object({
  requestId: z.string().uuid(),
  amount: z.number().int().min(1).max(BANK_LIMITS.maxAmount)
});

bank.post("/bank/deposit", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const parsed = opBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "金額を確かめてください。" });
    return;
  }
  if (!allow(`bank:${me}`, 20, 60_000)) {
    res.status(429).json({ ok: false, error: "操作が多すぎます。少し待ってからお試しください。" });
    return;
  }
  try {
    res.json(await withLock(`bank:${me}`, () => deposit(me, parsed.data.requestId, parsed.data.amount)));
  } catch (error) {
    sendError(res, error);
  }
});

bank.post("/bank/withdraw", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const parsed = opBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "金額を確かめてください。" });
    return;
  }
  if (!allow(`bank:${me}`, 20, 60_000)) {
    res.status(429).json({ ok: false, error: "操作が多すぎます。少し待ってからお試しください。" });
    return;
  }
  try {
    res.json(await withLock(`bank:${me}`, () => withdraw(me, parsed.data.requestId, parsed.data.amount)));
  } catch (error) {
    sendError(res, error);
  }
});

const investBody = z.object({
  creatorId: z.string().uuid(),
  amount: z.number().int().min(BANK_LIMITS.minInvest).max(BANK_LIMITS.maxAmount)
});

bank.post("/bank/invest", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const parsed = investBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: `投資は ${BANK_LIMITS.minInvest}pt から入れられます。` });
    return;
  }
  const { creatorId, amount } = parsed.data;
  if (creatorId === me) {
    res.status(400).json({ ok: false, error: "自分の作品には投資できません。" });
    return;
  }
  try {
    const result = await withLock(`bank:${me}`, async () => {
      if (!(await isInvestable(creatorId))) throw new BankError(404, "この開発者には投資できません。");
      const { data, error } = await sb.rpc("sc_bank_invest", {
        p_user: me,
        p_creator: creatorId,
        p_amount: amount,
        p_daily_rate: bankRates().dailyRate
      });
      if (error) throw error;
      return data as string;
    });
    if (result === "insufficient") {
      res.status(409).json({ ok: false, error: "預金が足りません。" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

bank.post("/bank/divest", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const parsed = investBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "金額を確かめてください。" });
    return;
  }
  const { creatorId, amount } = parsed.data;
  try {
    const result = await withLock(`bank:${me}`, async () => {
      const { data, error } = await sb.rpc("sc_bank_divest", {
        p_user: me,
        p_creator: creatorId,
        p_amount: amount,
        p_daily_rate: bankRates().dailyRate
      });
      if (error) throw error;
      return data as string;
    });
    if (result === "insufficient") {
      res.status(409).json({ ok: false, error: "投資した額が足りません。" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

const settingsBody = z.object({ showName: z.boolean() });

bank.post("/bank/settings", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const parsed = settingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "設定を読めませんでした。" });
    return;
  }
  try {
    const { error } = await sb
      .from("sc_bank_accounts")
      .upsert({ user_id: me, show_name: parsed.data.showName }, { onConflict: "user_id" });
    if (error) throw error;
    res.json({ ok: true, showName: parsed.data.showName });
  } catch (error) {
    sendError(res, error);
  }
});

// 銀行の画面に必要な全部（残高・投資・作者・ランキング・履歴）
async function buildState(me: string) {
  const rates = bankRates();
  const nowMs = Date.now();
  const [linked, accountRes, investmentRes, dividendRes, eventRes, rankingRes, creatorRes] = await Promise.all([
    isLinked(me),
    sb.from("sc_bank_accounts").select("principal, earned_interest, last_accrued_at, show_name").eq("user_id", me).maybeSingle(),
    sb.from("sc_bank_investments").select("creator_id, amount").eq("user_id", me),
    sb.from("sc_bank_events").select("creator_id, amount").eq("user_id", me).eq("kind", "dividend"),
    sb.from("sc_bank_events").select("id, kind, amount, creator_id, created_at").eq("user_id", me).order("created_at", { ascending: false }).limit(30),
    sb.rpc("sc_bank_ranking", { p_daily_rate: rates.dailyRate, p_limit: BANK_LIMITS.rankingSize, p_user: me }),
    sb.from("sc_studio_works").select("creator_id").eq("status", "published").limit(500)
  ]);
  for (const r of [accountRes, investmentRes, dividendRes, eventRes, rankingRes, creatorRes]) {
    if (r.error) throw r.error;
  }

  const account = accountRes.data;
  const principal = num(account?.principal);
  const earned = num(account?.earned_interest);
  const lastAccruedMs = account ? new Date(String(account.last_accrued_at)).getTime() : nowMs;
  const pending = interestSince(principal, rates.dailyRate, lastAccruedMs, nowMs);
  const investments = (investmentRes.data ?? []) as { creator_id: string; amount: number }[];
  const investedTotal = investments.reduce((sum, row) => sum + num(row.amount), 0);

  // 投資できる作者（公開中の作品がある人。自分は除く）
  const publishedRows = (creatorRes.data ?? []) as { creator_id: string }[];
  const creatorIds = [...new Set(publishedRows.map((r) => String(r.creator_id)).filter((id) => id !== me))].slice(0, 30);
  const rankingRows = (rankingRes.data ?? []) as { r_user_id: string; r_total: number; r_position: number; r_show_name: boolean }[];
  const eventRows = (eventRes.data ?? []) as { id: number; kind: string; amount: number; creator_id: string | null; created_at: string }[];
  const dividendRows = (dividendRes.data ?? []) as { creator_id: string; amount: number }[];

  // 名前をまとめて引く。対象が空のときも同じ形の問い合わせにするため、ダミーの ID を入れる
  const allIds = [
    ...new Set([
      ...investments.map((r) => String(r.creator_id)),
      ...creatorIds,
      ...eventRows.map((r) => r.creator_id).filter((id): id is string => Boolean(id)),
      ...rankingRows.map((r) => String(r.r_user_id))
    ])
  ];
  const userRes = await sb.from("sc_users").select("id, display_name").in("id", nonEmpty(allIds));
  if (userRes.error) throw userRes.error;
  const nameOf = new Map(((userRes.data ?? []) as { id: string; display_name: string }[]).map((u) => [String(u.id), String(u.display_name)]));

  // 作者ごとの投資家の数・投資の合計・売上（作者の受け取り前の額）
  const investAllRes = await sb
    .from("sc_bank_investments")
    .select("creator_id, user_id, amount")
    .in("creator_id", nonEmpty(creatorIds));
  if (investAllRes.error) throw investAllRes.error;
  const salesRes = await sb
    .from("sc_studio_payouts")
    .select("creator_id, gross_amount, amount")
    .in("creator_id", nonEmpty(creatorIds));
  if (salesRes.error) throw salesRes.error;
  const allInvestRows = (investAllRes.data ?? []) as { creator_id: string; user_id: string; amount: number }[];
  const salesRows = (salesRes.data ?? []) as { creator_id: string; gross_amount: number | null; amount: number }[];

  const creators = creatorIds.map((id) => {
    const rows = allInvestRows.filter((r) => String(r.creator_id) === id);
    const sales = salesRows.filter((r) => String(r.creator_id) === id);
    return {
      id,
      name: nameOf.get(id) ?? "開発者",
      works: publishedRows.filter((r) => String(r.creator_id) === id).length,
      investors: new Set(rows.map((r) => String(r.user_id))).size,
      invested: rows.reduce((sum, r) => sum + num(r.amount), 0),
      sales: sales.reduce((sum, r) => sum + num(r.gross_amount ?? r.amount), 0),
      myInvested: investments.find((r) => r.creator_id === id)?.amount ?? 0
    };
  });

  const dividendsByCreator = new Map<string, number>();
  for (const row of dividendRows) {
    dividendsByCreator.set(row.creator_id, (dividendsByCreator.get(row.creator_id) ?? 0) + num(row.amount));
  }
  const dividendTotal = [...dividendsByCreator.values()].reduce((sum, v) => sum + v, 0);

  const ranking = rankingRows.map((row) => {
    const id = String(row.r_user_id);
    const isMe = id === me;
    const showName = isMe || row.r_show_name;
    return {
      position: num(row.r_position),
      name: showName ? (nameOf.get(id) ?? "ユーザー") : "匿名のユーザー",
      total: num(row.r_total),
      isMe
    };
  });
  const myRow = rankingRows.find((row) => String(row.r_user_id) === me);

  return {
    linked,
    asOf: new Date(nowMs).toISOString(),
    rates: {
      dailyPercent: rates.dailyRate * 100,
      annualPercent: rates.dailyRate * 365 * 100,
      dividendPercent: rates.dividendRate * 100
    },
    limits: { minInvest: BANK_LIMITS.minInvest, maxAmount: BANK_LIMITS.maxAmount },
    deposit: {
      principal,
      // 利息（確定済み＋まだ確定していない分）
      interest: earned + pending,
      // 1秒あたりに増える利息（画面で滑らかに数を増やすのに使う）
      perSecond: (principal * rates.dailyRate) / 86_400,
      total: principal + earned + pending,
      showName: account ? Boolean(account.show_name) : true
    },
    investedTotal,
    dividendTotal,
    investments: investments
      .filter((row) => num(row.amount) > 0)
      .map((row) => ({
        creatorId: row.creator_id,
        name: nameOf.get(row.creator_id) ?? "開発者",
        amount: num(row.amount),
        dividends: dividendsByCreator.get(row.creator_id) ?? 0
      })),
    creators,
    ranking: {
      items: ranking,
      me: myRow ? { position: num(myRow.r_position), total: num(myRow.r_total) } : null
    },
    history: eventRows.map((row) => ({
      id: String(row.id),
      kind: row.kind,
      amount: num(row.amount),
      creatorName: row.creator_id ? (nameOf.get(row.creator_id) ?? null) : null,
      createdAt: row.created_at
    }))
  };
}

bank.get("/bank/state", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  try {
    const state = await withLock(`bank:${me}`, async () => {
      // 途中の操作の再開に失敗しても、残高の表示は続ける（再開は次の機会にもう一度行う）
      await resumePending(me).catch((error) => console.error("[bank] 途中の操作の再開に失敗:", error));
      return buildState(me);
    });
    res.json({ ok: true, ...state });
  } catch (error) {
    sendError(res, error);
  }
});
