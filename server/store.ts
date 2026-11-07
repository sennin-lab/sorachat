// 仙人ストアの API。ポイントは仙人アカウント（OAuth で連携した人）のものを使う。
// 購入は「購入の記録を作る → 仙人アカウントでポイントを減らす → 商品を持たせる」の順で行い、
// 同じ購入は同じ idempotency_key で再送するので、通信が途切れても二重に払わない。
import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { sb } from "./supabase.js";
import { ownedItemIds, canUseItem } from "./storeAccess.js";
import { STORE_ITEMS, storeItemById, type StoreItem } from "./storeCatalog.js";
import {
  adjustPoints,
  type AdjustResult,
  clearLink,
  DEFINITE_FAILURE,
  fetchBalance,
  isLinked,
  SenninError,
  withLock
} from "./senninPoints.js";

export const store = Router();
store.use("/store", requireAuth);

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

const NEEDS_LINK = "仙人アカウントと連携すると、ポイントで買い物できます。";

// 仙人アカウント関連のエラーを、画面に返す形に変える
function sendSenninError(res: Response, error: unknown) {
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
    ...(error.points !== undefined ? { points: error.points } : {})
  });
}

// 商品の一覧と、持っているか。仙人アカウントには問い合わせない（速く返すため）
store.get("/store", async (_req, res) => {
  const me = currentUserId(res);
  const [linked, owned, selectedTheme] = await Promise.all([
    isLinked(me),
    ownedItemIds(me),
    sb.from("sc_users").select("store_theme").eq("id", me).maybeSingle().then(({ data, error }) => {
      if (error) throw error;
      return (data?.store_theme as string | null) ?? null;
    })
  ]);
  res.set("Cache-Control", "no-store");
  res.json({
    linked,
    selectedTheme,
    items: STORE_ITEMS.map((item) => ({
      ...item,
      owned: item.price <= 0 || owned.has(item.id),
      selected: item.kind === "theme" && item.id === selectedTheme
    }))
  });
});

// 仙人アカウントのポイント残高（ストアを開いたときに取りに行く）
store.get("/store/balance", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  try {
    if (!(await isLinked(me))) {
      res.status(403).json({ ok: false, error: NEEDS_LINK, code: "not_linked", needsLink: true });
      return;
    }
    res.json({ ok: true, points: await fetchBalance(me) });
  } catch (error) {
    sendSenninError(res, error);
  }
});

const purchaseSchema = z.object({ itemId: z.string().min(1).max(64) });

async function purchase(me: string, item: StoreItem) {
  if (!(await isLinked(me))) throw new SenninError("not_linked", NEEDS_LINK);
  if (await canUseItem(me, item)) throw new SenninError("owned", "すでに持っている商品です。");

  // 前回の購入の結果が分からないままのものがあれば、それを同じ購入として確かめ直す（二重に払わないため）
  const { data: pending, error: pendingError } = await sb
    .from("sc_store_purchases")
    .select("id")
    .eq("user_id", me)
    .eq("item_id", item.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (pendingError) throw pendingError;

  let purchaseId = (pending?.id as string | undefined) ?? null;
  if (!purchaseId) {
    purchaseId = randomUUID();
    const { error } = await sb.from("sc_store_purchases").insert({
      id: purchaseId,
      user_id: me,
      item_id: item.id,
      price: item.price,
      status: "pending"
    });
    if (error) throw error;
  }

  let result: AdjustResult;
  try {
    result = await adjustPoints(me, {
      amount: -item.price,
      reason: `ソラチャットストア：${item.name}`.slice(0, 100),
      idempotencyKey: `sc-${purchaseId}`
    });
  } catch (error) {
    // 確実に実行されなかった失敗は、購入を失敗として閉じる（次は新しい購入として始める）
    if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
      await sb
        .from("sc_store_purchases")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", purchaseId);
    }
    throw error;
  }

  const { error: grantError } = await sb
    .from("sc_store_items")
    .upsert({ user_id: me, item_id: item.id, purchase_id: purchaseId }, { onConflict: "user_id,item_id", ignoreDuplicates: true });
  if (grantError) throw grantError;
  await sb
    .from("sc_store_purchases")
    .update({ status: "completed", sennin_ledger_id: result.ledgerId, updated_at: new Date().toISOString() })
    .eq("id", purchaseId);
  return { ok: true as const, itemId: item.id, points: result.points, replayed: result.replayed };
}

store.post("/store/purchase", async (req, res) => {
  const me = currentUserId(res);
  const parsed = purchaseSchema.safeParse(req.body);
  const item = parsed.success ? storeItemById(parsed.data.itemId) : null;
  if (!item) {
    res.status(404).json({ ok: false, error: "商品が見つかりません。" });
    return;
  }
  if (item.price <= 0) {
    res.status(400).json({ ok: false, error: "この商品は無料です。" });
    return;
  }
  if (!allow(`purchase:${me}`, 10, 60_000)) {
    res.status(429).json({ ok: false, error: "操作が多すぎます。少し待ってからお試しください。" });
    return;
  }
  try {
    res.json(await withLock(`store:${me}`, () => purchase(me, item)));
  } catch (error) {
    if (error instanceof SenninError && error.code === "owned") {
      res.status(409).json({ ok: false, error: error.message, code: "owned" });
      return;
    }
    sendSenninError(res, error);
  }
});

const themeSchema = z.object({ itemId: z.string().min(1).max(64).nullable() });

// 外観の選択（持っている外観だけ選べる）。null で標準に戻す
store.post("/store/theme", async (req, res) => {
  const me = currentUserId(res);
  const parsed = themeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "外観を選んでください。" });
    return;
  }
  let storeTheme: string | null = null;
  if (parsed.data.itemId !== null) {
    const item = storeItemById(parsed.data.itemId);
    if (!item || item.kind !== "theme") {
      res.status(404).json({ error: "外観が見つかりません。" });
      return;
    }
    if (!(await canUseItem(me, item))) {
      res.status(403).json({ error: "この外観はまだ購入していません。" });
      return;
    }
    storeTheme = item.id;
  }
  const { error } = await sb.from("sc_users").update({ store_theme: storeTheme }).eq("id", me);
  if (error) throw error;
  res.json({ ok: true, storeTheme });
});

// ストアの連携を解除する（購入した商品は残る）
store.post("/store/unlink", async (_req, res) => {
  await clearLink(currentUserId(res));
  res.json({ ok: true });
});
