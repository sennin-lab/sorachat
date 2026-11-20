// SenninPay：仙人アカウントのポイントを、友だちへ送ったり、店舗のQRで払ったりする。
//
// ・ポイントの実体は仙人アカウント側にある。送る人の残高を減らし（-N）、受け取る人の残高を増やす（+N）。
// ・2つの操作は同時にはできないので、次の順で進める（送金の記録 sc_pay_transfers の status で追う）
//     pending（支払い側の減算を確かめていない）→ debited（減算済み）→ completed（受け取り側の加算済み）
//   受け取り側へ渡せないと分かったとき（連携切れ・権限・上限など）は、送った人へ返金して refunded にする。
// ・どの操作も idempotency_key（sp-送金ID-out / -in / -refund）で行うので、通信が途切れて再送しても二重には動かない。
//   途中で止まった送金は、送った人か受け取った人が履歴を開いたときに続きから進める。
// ・友だちへの送金は、友だちどうしのときだけ。店舗への支払いは、申請して有効になっている店舗のQRだけ。
// ・どちらも、相手が仙人アカウントと連携している必要がある（ポイントを受け取るため）。
import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { sb } from "./supabase.js";
import { UUID } from "./messages.js";
import { adjustPoints, DEFINITE_FAILURE, fetchBalance, isLinked, SenninError, withLock } from "./senninPoints.js";
import { retryPendingLoginBonus } from "./loginBonus.js";

export const senninPay = Router();
senninPay.use("/pay", requireAuth);

export const PAY_MAX_AMOUNT = 10_000;
export const PAY_MAX_MEMO = 60;
const NEEDS_LINK = "SenninPayを使うには、仙人アカウントと連携してください。";

// 店舗のQRに入れる値（読み取り側はこの形からユーザーIDを取り出す）
export const merchantQrValue = (userId: string) => `sorachat://pay/${userId}`;

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

// 仙人アカウント関連のエラーを、画面に返す形に変える（ストアと同じ分け方）
function sendPayError(res: Response, error: unknown, extra: Record<string, unknown> = {}) {
  if (!(error instanceof SenninError)) throw error;
  const status =
    error.code === "not_linked"
      ? 403
      : error.code === "insufficient_points"
        ? 409
        : error.code === "scope"
          ? 403
          : error.code === "daily_limit"
            ? 429
            : error.code === "invalid"
              ? 400
              : 502;
  res.status(status).json({
    ok: false,
    error: error.message,
    code: error.code,
    needsLink: error.code === "not_linked",
    ...(error.points !== undefined ? { points: error.points } : {}),
    ...extra
  });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "送金に失敗しました。").slice(0, 200);
const isDefinite = (error: unknown) => error instanceof SenninError && DEFINITE_FAILURE.has(error.code);

// 送金の状態（sc_pay_transfers）
type TransferRow = {
  id: string;
  from_user: string;
  to_user: string;
  amount: number;
  memo: string;
  kind: "friend" | "qr";
  status: string;
  last_error: string | null;
  created_at: string;
};
const TRANSFER_COLUMNS = "id, from_user, to_user, amount, memo, kind, status, last_error, created_at";

async function loadTransfer(id: string): Promise<TransferRow> {
  const { data, error } = await sb.from("sc_pay_transfers").select(TRANSFER_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new SenninError("invalid", "送金が見つかりません。");
  return data as TransferRow;
}

async function setStatus(id: string, status: string, extra: Record<string, unknown> = {}) {
  const { error } = await sb
    .from("sc_pay_transfers")
    .update({ status, ...extra, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

const reasonOf = (kind: "送信" | "受取" | "返金", t: TransferRow) =>
  (t.kind === "qr" ? `SenninPay（店舗のお支払い・${kind}）` : `SenninPay（友だちへの送金・${kind}）`).slice(0, 100);

// 送金を先へ進める。呼ぶ前に、支払い側のロック（pay:支払い側）を取っておくこと
async function runTransfer(id: string): Promise<TransferRow> {
  let t = await loadTransfer(id);

  // 1. 支払い側から減らす
  if (t.status === "pending") {
    try {
      const result = await adjustPoints(t.from_user, {
        amount: -t.amount,
        reason: reasonOf("送信", t),
        idempotencyKey: `sp-${t.id}-out`
      });
      await setStatus(t.id, "debited", { debit_ledger_id: result.ledgerId, last_error: null });
    } catch (error) {
      // 確実に減っていないなら failed（送金は成立しない）。分からないときは pending のまま（あとで確かめ直す）
      await setStatus(t.id, isDefinite(error) ? "failed" : "pending", { last_error: messageOf(error) });
      throw error;
    }
    t = await loadTransfer(id);
  }

  // 2. 受け取り側へ増やす
  if (t.status === "debited") {
    try {
      const result = await adjustPoints(t.to_user, {
        amount: t.amount,
        reason: reasonOf("受取", t),
        idempotencyKey: `sp-${t.id}-in`
      });
      await setStatus(t.id, "completed", { credit_ledger_id: result.ledgerId, last_error: null });
    } catch (error) {
      if (!isDefinite(error)) {
        // 通信の結果が分からないときは debited のまま。次に続きから進める（同じキーなので二重にならない）
        await setStatus(t.id, "debited", { last_error: messageOf(error) });
        throw error;
      }
      // 受け取れないと分かったら、支払い側へ返す
      try {
        const result = await adjustPoints(t.from_user, {
          amount: t.amount,
          reason: reasonOf("返金", t),
          idempotencyKey: `sp-${t.id}-refund`
        });
        await setStatus(t.id, "refunded", { refund_ledger_id: result.ledgerId, last_error: messageOf(error) });
      } catch (refundError) {
        await setStatus(t.id, "debited", { last_error: `返金できていません：${messageOf(refundError)}` });
        throw refundError;
      }
      throw new SenninError("invalid", `相手に渡せなかったため、ポイントは返金しました（${messageOf(error)}）`);
    }
  }
  return loadTransfer(id);
}

// 途中で止まっている送金を、続きから進める（履歴を開いたとき・支払いの前に呼ぶ）。失敗は無視する
export async function resumeTransfers(userId: string): Promise<void> {
  const { data, error } = await sb
    .from("sc_pay_transfers")
    .select("id, from_user")
    .or(`from_user.eq.${userId},to_user.eq.${userId}`)
    .in("status", ["pending", "debited"])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw error;
  for (const row of data ?? []) {
    await withLock(`pay:${row.from_user as string}`, () => runTransfer(row.id as string)).catch(() => undefined);
  }
}

// 友だちか（相互に友だちになっているか）
async function areFriends(me: string, other: string): Promise<boolean> {
  const { data, error } = await sb.from("sc_friends").select("user_id").eq("user_id", me).eq("friend_id", other).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function activeMerchant(userId: string): Promise<{ name: string } | null> {
  const { data, error } = await sb.from("sc_merchants").select("name, status").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "active") return null;
  return { name: data.name as string };
}

// 送金の本体。同じ clientId で再送されたときは、同じ送金として続きから進める（二重にしない）
export async function sendPoints(args: {
  me: string;
  to: string;
  amount: number;
  memo: string;
  kind: "friend" | "qr";
  clientId: string | null;
}): Promise<TransferRow> {
  if (args.to === args.me) throw new SenninError("invalid", "自分には送れません。");
  if (!(await isLinked(args.me))) throw new SenninError("not_linked", NEEDS_LINK);

  if (args.clientId) {
    const { data, error } = await sb
      .from("sc_pay_transfers")
      .select("id")
      .eq("from_user", args.me)
      .eq("client_id", args.clientId)
      .maybeSingle();
    if (error) throw error;
    if (data) return withLock(`pay:${args.me}`, () => runTransfer(data.id as string));
  }

  if (args.kind === "friend") {
    if (!(await areFriends(args.me, args.to))) throw new SenninError("invalid", "友だちにだけポイントを送れます。");
  } else if (!(await activeMerchant(args.to))) {
    throw new SenninError("invalid", "この店舗は今、お支払いを受け付けていません。");
  }
  if (!(await isLinked(args.to))) {
    throw new SenninError("invalid", "相手は仙人アカウントと連携していないため、ポイントを受け取れません。");
  }

  const id = randomUUID();
  const { error } = await sb.from("sc_pay_transfers").insert({
    id,
    from_user: args.me,
    to_user: args.to,
    amount: args.amount,
    memo: args.memo,
    kind: args.kind,
    client_id: args.clientId,
    status: "pending"
  });
  if (error) {
    // 同じ clientId で同時に作られたときは、そちらの送金として続ける
    if (error.code === "23505" && args.clientId) {
      const { data } = await sb
        .from("sc_pay_transfers")
        .select("id")
        .eq("from_user", args.me)
        .eq("client_id", args.clientId)
        .maybeSingle();
      if (data) return withLock(`pay:${args.me}`, () => runTransfer(data.id as string));
    }
    throw error;
  }
  return withLock(`pay:${args.me}`, () => runTransfer(id));
}

const amountSchema = z.number().int().min(1).max(PAY_MAX_AMOUNT);
const memoSchema = z.string().max(PAY_MAX_MEMO).optional().default("");
const clientIdSchema = z.string().regex(UUID).nullable().optional();
const friendSchema = z.object({ toUserId: z.string().regex(UUID), amount: amountSchema, memo: memoSchema, clientId: clientIdSchema });
const qrSchema = z.object({ merchantId: z.string().regex(UUID), amount: amountSchema, memo: memoSchema, clientId: clientIdSchema });
const merchantSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional().default("")
});

// 送金の結果の文言（完了以外は、理由を分かる形で返す）
function resultOf(t: TransferRow) {
  if (t.status === "completed") return { ok: true as const };
  if (t.status === "refunded") return { ok: false as const, error: "相手に渡せなかったため、ポイントは返金しました。" };
  if (t.status === "failed") return { ok: false as const, error: t.last_error ?? "送金できませんでした。" };
  return { ok: false as const, error: "結果を確かめています。履歴でご確認ください。" };
}

// 送金の結果を、画面に返す形に変える
function transferView(t: TransferRow, me: string) {
  return {
    id: t.id,
    direction: t.from_user === me ? "out" : "in",
    amount: t.amount,
    memo: t.memo,
    kind: t.kind,
    status: t.status,
    createdAt: t.created_at
  };
}

// ---- 残高・履歴 ----

// 残高（仙人アカウントのポイント）。連携していなければ linked: false
senninPay.get("/pay/balance", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  try {
    if (!(await isLinked(me))) {
      res.json({ ok: true, linked: false, points: null });
      return;
    }
    const points = await fetchBalance(me);
    // 保留中のログイン特典があれば、ついでに再試行する（画面は待たせない）
    void retryPendingLoginBonus(me).catch(() => undefined);
    res.json({ ok: true, linked: true, points });
  } catch (error) {
    sendPayError(res, error);
  }
});

// 送金・支払いの履歴（途中の送金は続きから進めてから返す）
senninPay.get("/pay/history", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  try {
    await resumeTransfers(me);
    const { data, error } = await sb
      .from("sc_pay_transfers")
      .select(TRANSFER_COLUMNS)
      .or(`from_user.eq.${me},to_user.eq.${me}`)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    const rows = (data ?? []) as TransferRow[];
    const others = [...new Set(rows.map((row) => (row.from_user === me ? row.to_user : row.from_user)))];
    const names = new Map<string, string>();
    if (others.length) {
      const { data: users, error: usersError } = await sb.from("sc_users").select("id, display_name").in("id", others);
      if (usersError) throw usersError;
      for (const user of users ?? []) names.set(user.id as string, user.display_name as string);
    }
    res.json({
      ok: true,
      items: rows.map((row) => ({
        ...transferView(row, me),
        counterpartName: names.get(row.from_user === me ? row.to_user : row.from_user) ?? "",
        error: row.from_user === me ? row.last_error : null
      }))
    });
  } catch (error) {
    sendPayError(res, error);
  }
});

// ---- 送金・支払い ----

// 友だちにポイントを送る
senninPay.post("/pay/friend", async (req, res) => {
  const me = currentUserId(res);
  const parsed = friendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "送る相手と金額（1〜10,000pt）を確かめてください。" });
    return;
  }
  if (!allow(`pay:${me}`, 30, 60_000)) {
    res.status(429).json({ ok: false, error: "操作が多すぎます。少し待ってからお試しください。" });
    return;
  }
  try {
    const t = await sendPoints({
      me,
      to: parsed.data.toUserId,
      amount: parsed.data.amount,
      memo: parsed.data.memo.trim(),
      kind: "friend",
      clientId: parsed.data.clientId ?? null
    });
    res.json({ ...resultOf(t), transfer: transferView(t, me) });
  } catch (error) {
    sendPayError(res, error);
  }
});

// 店舗のQRで支払う（QRに入っている店舗のユーザーへ）
senninPay.post("/pay/qr", async (req, res) => {
  const me = currentUserId(res);
  const parsed = qrSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "店舗と金額（1〜10,000pt）を確かめてください。" });
    return;
  }
  if (!allow(`pay:${me}`, 30, 60_000)) {
    res.status(429).json({ ok: false, error: "操作が多すぎます。少し待ってからお試しください。" });
    return;
  }
  try {
    const t = await sendPoints({
      me,
      to: parsed.data.merchantId,
      amount: parsed.data.amount,
      memo: parsed.data.memo.trim(),
      kind: "qr",
      clientId: parsed.data.clientId ?? null
    });
    res.json({ ...resultOf(t), transfer: transferView(t, me) });
  } catch (error) {
    sendPayError(res, error);
  }
});

// ---- 店舗 ----

// QRを読み取ったあとに、店舗の名前を確かめる（有効な店舗だけ）
senninPay.get("/pay/merchants/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ ok: false, error: "店舗が見つかりません。" });
    return;
  }
  const { data, error } = await sb.from("sc_merchants").select("user_id, name, description, status").eq("user_id", id).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "active") {
    res.status(404).json({ ok: false, error: "この店舗は今、お支払いを受け付けていません。" });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, merchant: { id: data.user_id, name: data.name, description: data.description } });
});

// 自分の店舗（申請していれば、QRの値も返す）
senninPay.get("/pay/merchant", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const [{ data, error }, linked] = await Promise.all([
    sb.from("sc_merchants").select("user_id, name, description, status, created_at").eq("user_id", me).maybeSingle(),
    isLinked(me)
  ]);
  if (error) throw error;
  res.json({
    ok: true,
    linked,
    merchant: data
      ? {
          id: data.user_id,
          name: data.name,
          description: data.description,
          status: data.status,
          createdAt: data.created_at,
          qrValue: merchantQrValue(me)
        }
      : null
  });
});

// 店舗を申請する。申請したらQRが発行される（審査はなし。運営はいつでも止められる）
senninPay.post("/pay/merchant", async (req, res) => {
  const me = currentUserId(res);
  const parsed = merchantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "店舗の名前（1〜40文字）を入力してください。" });
    return;
  }
  try {
    if (!(await isLinked(me))) throw new SenninError("not_linked", NEEDS_LINK);
    const { data: existing, error: existingError } = await sb.from("sc_merchants").select("user_id").eq("user_id", me).maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      res.status(409).json({ ok: false, error: "すでに店舗を申請しています。" });
      return;
    }
    const { data, error } = await sb
      .from("sc_merchants")
      .insert({ user_id: me, name: parsed.data.name, description: parsed.data.description ?? "", status: "active" })
      .select("user_id, name, description, status, created_at")
      .single();
    if (error) {
      if (error.code === "23505") {
        res.status(409).json({ ok: false, error: "すでに店舗を申請しています。" });
        return;
      }
      throw error;
    }
    res.json({
      ok: true,
      merchant: {
        id: data.user_id,
        name: data.name,
        description: data.description,
        status: data.status,
        createdAt: data.created_at,
        qrValue: merchantQrValue(me)
      }
    });
  } catch (error) {
    sendPayError(res, error);
  }
});
