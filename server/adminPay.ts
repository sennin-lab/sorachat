// 管理者パネルの「ストア・Pay」用の API（管理者の証明が必要）。
//   ・店舗の一覧・停止・再開（SenninPay の店舗）
//   ・仙人ストアのラインナップの一覧・編集（名前・説明・価格・スタンプの中身・販売の有無）
//   ・スタンプパックの追加
import { Router } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { requireAdmin } from "./admin.js";
import { sb } from "./supabase.js";
import { UUID } from "./messages.js";
import { LINEUP_LIMITS, checkChange, checkStamps, createStampPack, loadLineup, saveLineupChange, type LineupItem } from "./storeLineup.js";

export const adminPay = Router();
adminPay.use("/admin", requireAdmin);

// ---- 店舗 ----

adminPay.get("/admin/merchants", async (_req, res) => {
  const { data, error } = await sb
    .from("sc_merchants")
    .select("user_id, name, description, status, created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  const ids = (data ?? []).map((row) => row.user_id as string);
  const owners = new Map<string, string>();
  if (ids.length) {
    const { data: users, error: usersError } = await sb.from("sc_users").select("id, username, display_name").in("id", ids);
    if (usersError) throw usersError;
    for (const user of users ?? []) owners.set(user.id as string, `${user.display_name as string}（@${user.username as string}）`);
  }
  res.json({
    merchants: (data ?? []).map((row) => ({
      id: row.user_id,
      name: row.name,
      description: row.description,
      status: row.status,
      ownerName: owners.get(row.user_id as string) ?? "",
      createdAt: row.created_at
    }))
  });
});

const statusSchema = z.object({ status: z.enum(["active", "suspended"]) });

// 店舗の停止（suspended）と再開（active）。停止中はQRで支払えない
adminPay.post("/admin/merchants/:id/status", async (req, res) => {
  const id = String(req.params.id);
  const parsed = statusSchema.safeParse(req.body);
  if (!UUID.test(id) || !parsed.success) {
    res.status(400).json({ error: "店舗と状態を確かめてください。" });
    return;
  }
  const { data, error } = await sb
    .from("sc_merchants")
    .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
    .eq("user_id", id)
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "店舗が見つかりません。" });
    return;
  }
  res.json({ ok: true });
});

// ---- ストアのラインナップ ----

const lineupView = (item: LineupItem) => ({
  id: item.id,
  kind: item.kind,
  name: item.name,
  description: item.description,
  price: item.price,
  stamps: item.stamps ?? [],
  feature: item.feature ?? null,
  enabled: item.enabled,
  custom: item.custom
});

adminPay.get("/admin/store/lineup", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    items: (await loadLineup()).map(lineupView),
    operatorConfigured: Boolean(config.operatorUserId),
    limits: LINEUP_LIMITS
  });
});

const changeSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  price: z.number().optional(),
  stamps: z.unknown().optional(),
  enabled: z.boolean().optional()
});

// 商品を変える（名前・説明・価格・スタンプの中身・販売の有無）
adminPay.post("/admin/store/items/:id", async (req, res) => {
  const id = String(req.params.id);
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "変更の内容が正しくありません。" });
    return;
  }
  const item = (await loadLineup()).find((x) => x.id === id);
  if (!item) {
    res.status(404).json({ error: "商品が見つかりません。" });
    return;
  }
  const checked = checkChange(item, parsed.data);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (Object.keys(checked.value).length === 0) {
    res.status(400).json({ error: "変更する内容がありません。" });
    return;
  }
  await saveLineupChange(id, checked.value);
  const updated = (await loadLineup()).find((x) => x.id === id);
  res.json({ ok: true, item: updated ? lineupView(updated) : null });
});

const packSchema = z.object({
  name: z.string().trim().min(1).max(LINEUP_LIMITS.nameMax),
  description: z.string().trim().max(LINEUP_LIMITS.descriptionMax).optional().default(""),
  price: z.number().int().min(0).max(LINEUP_LIMITS.priceMax),
  stamps: z.unknown()
});

// スタンプパックを追加する（中身は組み込みのスタンプから選ぶ）
adminPay.post("/admin/store/packs", async (req, res) => {
  const parsed = packSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "名前（1〜40文字）と価格（0〜5,000pt）を確かめてください。" });
    return;
  }
  const stamps = checkStamps(parsed.data.stamps);
  if (!stamps.ok) {
    res.status(400).json({ error: stamps.error });
    return;
  }
  if (stamps.stamps.length === 0) {
    res.status(400).json({ error: "スタンプは1種類以上入れてください。" });
    return;
  }
  const id = await createStampPack({
    name: parsed.data.name,
    description: parsed.data.description ?? "",
    price: parsed.data.price,
    stamps: stamps.stamps
  });
  res.json({ ok: true, id });
});
