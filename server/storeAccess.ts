// 仙人ストアの「持っているか」の判定。スタンプ送信・ミニゲーム・senninaiのグループ参加から使う。
// 無料の商品（price が 0）は、買っていなくても常に使える扱いにする。
// 商品の中身（どのパックにどのスタンプが入っているか）は、運営が変えられるので、ラインナップから毎回調べる。
import { sb } from "./supabase.js";
import { lineupFeatureItem, lineupPackOfStamp } from "./storeLineup.js";

export async function ownedItemIds(userId: string): Promise<Set<string>> {
  const { data, error } = await sb.from("sc_store_items").select("item_id").eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.item_id as string));
}

async function ownsRow(userId: string, itemId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("sc_store_items")
    .select("item_id")
    .eq("user_id", userId)
    .eq("item_id", itemId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// 商品を使えるか（無料、または購入済み）
export async function canUseItem(userId: string, item: { id: string; price: number }): Promise<boolean> {
  if (item.price <= 0) return true;
  return ownsRow(userId, item.id);
}

// 機能（bot:group など）を使えるか。機能に対応する商品がなければ制限しない
export async function featureAllowed(userId: string, feature: string): Promise<boolean> {
  const item = await lineupFeatureItem(feature);
  if (!item) return true;
  return canUseItem(userId, item);
}

// 正規化したスタンプの名前が、買っていないパックのものなら true（送れない）
export async function stampLocked(normalizedRef: string, userId: string): Promise<boolean> {
  const pack = await lineupPackOfStamp(normalizedRef);
  if (!pack) return false;
  return !(await canUseItem(userId, pack));
}
