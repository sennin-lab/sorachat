// 仙人ストアの商品の一覧（ラインナップ）。
// 基本の商品は storeCatalog.ts に書いてあり、運営は管理者パネルから次のことを変えられる（sc_store_overrides に保存）。
//   ・名前・説明・価格・スタンプの中身・販売の有無（enabled）
//   ・スタンプパックの新規追加（custom）
// 販売を止めた商品（enabled: false）は、買ってある人は引き続き使える。新しくは買えない。
import { randomBytes } from "node:crypto";
import { sb } from "./supabase.js";
import { STORE_ITEMS, type StoreItem } from "./storeCatalog.js";
import { normalizeStampRef } from "./stampRef.js";

export type LineupItem = StoreItem & { enabled: boolean; custom: boolean };

// 管理者が変えられる項目（保存する形）
export type LineupOverride = {
  name?: string;
  description?: string;
  price?: number;
  stamps?: string[];
  enabled?: boolean;
  // 運営が追加したスタンプパック（基本の商品にはない）
  custom?: boolean;
  kind?: "stamp_pack";
};

export const LINEUP_LIMITS = {
  nameMax: 40,
  descriptionMax: 200,
  priceMax: 5000,
  stampsMax: 60
} as const;

// 組み込みスタンプの指定（builtin:ファイル名）。stamps.ts の BUILTIN_REF と同じ形
const BUILTIN_STAMP = /^builtin:[^\/\\\x00-\x1f]{1,120}$/;

const TTL_MS = 10_000;
let cache: { at: number; items: LineupItem[] } | null = null;

// 変更したら、すぐ反映されるように覚えを捨てる
export function invalidateLineup() {
  cache = null;
}

async function readOverrides(): Promise<Map<string, LineupOverride>> {
  const { data, error } = await sb.from("sc_store_overrides").select("item_id, data");
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.item_id as string, (row.data ?? {}) as LineupOverride]));
}

function applyOverride(base: StoreItem, change: LineupOverride, custom: boolean): LineupItem {
  return {
    ...base,
    name: change.name ?? base.name,
    description: change.description ?? base.description,
    price: change.price ?? base.price,
    stamps: base.kind === "stamp_pack" ? change.stamps ?? base.stamps : base.stamps,
    enabled: change.enabled ?? true,
    custom
  };
}

// 商品の一覧（販売を止めたものも含む）。覚えを短い時間だけ使う
export async function loadLineup(): Promise<LineupItem[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.items;
  const overrides = await readOverrides();
  const base = STORE_ITEMS.map((item) => applyOverride(item, overrides.get(item.id) ?? {}, false));
  const baseIds = new Set(STORE_ITEMS.map((item) => item.id));
  const custom: LineupItem[] = [];
  for (const [id, change] of overrides) {
    if (!change.custom || baseIds.has(id)) continue;
    const shell: StoreItem = { id, kind: "stamp_pack", name: "", description: "", price: 0, stamps: [] };
    custom.push(applyOverride(shell, change, true));
  }
  const items = [...base, ...custom];
  cache = { at: Date.now(), items };
  return items;
}

// 買える商品（販売中のもの）
export async function visibleLineup(): Promise<LineupItem[]> {
  return (await loadLineup()).filter((item) => item.enabled);
}

// 商品を1つ探す。forSale のときは販売中のものだけ
export async function lineupItemById(id: string, forSale: boolean): Promise<LineupItem | null> {
  const item = (await loadLineup()).find((x) => x.id === id) ?? null;
  if (!item) return null;
  if (forSale && !item.enabled) return null;
  return item;
}

// 機能（bot:group など）に対応する商品。販売の有無にかかわらず、買ってある人の判定に使う
export async function lineupFeatureItem(feature: string): Promise<LineupItem | null> {
  return (await loadLineup()).find((item) => item.feature === feature) ?? null;
}

// 正規化したスタンプの名前を含むスタンプパック（なければ null）
export async function lineupPackOfStamp(normalizedRef: string): Promise<LineupItem | null> {
  return (
    (await loadLineup()).find((item) => item.kind === "stamp_pack" && (item.stamps ?? []).includes(normalizedRef)) ?? null
  );
}

export type LineupError = { ok: false; error: string };

// スタンプの指定を検査して、正規化した一覧を返す
export function checkStamps(list: unknown): { ok: true; stamps: string[] } | LineupError {
  if (!Array.isArray(list)) return { ok: false, error: "スタンプの一覧が正しくありません。" };
  if (list.length > LINEUP_LIMITS.stampsMax) {
    return { ok: false, error: `スタンプは${LINEUP_LIMITS.stampsMax}種類までです。` };
  }
  const stamps: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") return { ok: false, error: "スタンプの指定が正しくありません。" };
    const ref = normalizeStampRef(raw.trim());
    if (!BUILTIN_STAMP.test(ref)) {
      return { ok: false, error: `スタンプ「${raw}」は使えません（組み込みのスタンプだけ入れられます）。` };
    }
    if (!stamps.includes(ref)) stamps.push(ref);
  }
  return { ok: true, stamps };
}

function checkPrice(value: unknown): { ok: true; price: number } | LineupError {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LINEUP_LIMITS.priceMax) {
    return { ok: false, error: `価格は0〜${LINEUP_LIMITS.priceMax}ptの整数にしてください。` };
  }
  return { ok: true, price: value };
}

export type LineupChange = {
  name?: string;
  description?: string;
  price?: number;
  stamps?: unknown;
  enabled?: boolean;
};

// 管理者の変更を検査して、保存する形にする
export function checkChange(item: LineupItem, change: LineupChange): { ok: true; value: LineupOverride } | LineupError {
  const value: LineupOverride = {};
  if (change.name !== undefined) {
    const name = String(change.name).trim();
    if (!name || name.length > LINEUP_LIMITS.nameMax) return { ok: false, error: `名前は1〜${LINEUP_LIMITS.nameMax}文字にしてください。` };
    value.name = name;
  }
  if (change.description !== undefined) {
    const description = String(change.description).trim();
    if (description.length > LINEUP_LIMITS.descriptionMax) {
      return { ok: false, error: `説明は${LINEUP_LIMITS.descriptionMax}文字までです。` };
    }
    value.description = description;
  }
  if (change.price !== undefined) {
    const price = checkPrice(change.price);
    if (!price.ok) return price;
    value.price = price.price;
  }
  if (change.stamps !== undefined) {
    if (item.kind !== "stamp_pack") return { ok: false, error: "スタンプの中身は、スタンプパックだけ変えられます。" };
    const stamps = checkStamps(change.stamps);
    if (!stamps.ok) return stamps;
    if (stamps.stamps.length === 0) return { ok: false, error: "スタンプは1種類以上入れてください。" };
    value.stamps = stamps.stamps;
  }
  if (change.enabled !== undefined) value.enabled = Boolean(change.enabled);
  return { ok: true, value };
}

// 商品の変更を保存する（基本の商品の上書き、または運営のスタンプパックの更新）
export async function saveLineupChange(id: string, value: LineupOverride): Promise<void> {
  const overrides = await readOverrides();
  const merged = { ...(overrides.get(id) ?? {}), ...value };
  const { error } = await sb
    .from("sc_store_overrides")
    .upsert({ item_id: id, data: merged, updated_at: new Date().toISOString() }, { onConflict: "item_id" });
  if (error) throw error;
  invalidateLineup();
}

// 運営のスタンプパックを追加する
export async function createStampPack(args: { name: string; description: string; price: number; stamps: string[] }): Promise<string> {
  const id = `stamp-pack-${randomBytes(4).toString("hex")}`;
  const value: LineupOverride = {
    custom: true,
    kind: "stamp_pack",
    name: args.name,
    description: args.description,
    price: args.price,
    stamps: args.stamps,
    enabled: true
  };
  const { error } = await sb.from("sc_store_overrides").insert({ item_id: id, data: value, updated_at: new Date().toISOString() });
  if (error) throw error;
  invalidateLineup();
  return id;
}
