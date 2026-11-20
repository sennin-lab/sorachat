// senninstudio の作品データの共通処理。ルーター（studio.ts）・ストア（store.ts）・スタンプ・ミニゲーム・senninai から使う。
// 作品は、ストアでは「work:作品ID」という商品として扱う（購入の記録・所有の判定は既存の仕組みをそのまま使う）。
import { sb } from "./supabase.js";
import { canUseItem } from "./storeAccess.js";
import type { StoreItem } from "./storeCatalog.js";
import { aiStyleInstruction, type AiStylePayload, type QuizPayload, type StudioKind } from "./studioRules.js";
// 循環 import を避けるため、問題数の値はここにも置く（gameLogic.ts の QUIZ_ROUNDS と同じ）
const QUIZ_ROUNDS_FOR_PACKS = 5;

export const WORK_PREFIX = "work:";
const UUID = /^[0-9a-f-]{36}$/i;
export const STUDIO_STAMP_REF = /^studio:([0-9a-f-]{36})$/i;

export type WorkRow = {
  id: string;
  creator_id: string;
  kind: StudioKind;
  name: string;
  description: string;
  price: number;
  status: "published" | "hidden" | "deleted" | "removed";
  payload: Record<string, unknown> | null;
  created_at: string;
  // 作者が最後に編集した日時（編集していなければ null）
  edited_at?: string | null;
};

// ストアの商品として扱う作品（購入の処理に必要な情報を含む）
export type StudioStoreItem = StoreItem & { source: "studio"; creatorId: string; studioKind: StudioKind; status: WorkRow["status"] };

export const workIdOf = (itemId: string): string | null => {
  if (!itemId.startsWith(WORK_PREFIX)) return null;
  const id = itemId.slice(WORK_PREFIX.length);
  return UUID.test(id) ? id : null;
};

export async function loadWork(id: string): Promise<WorkRow | null> {
  const { data, error } = await sb
    .from("sc_studio_works")
    .select("id, creator_id, kind, name, description, price, status, payload, created_at, edited_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as WorkRow | null) ?? null;
}

// 買ったクイズ（問題が規定数以上あるもの）。ミニゲームの出題を選ぶ画面に出す
export async function ownedQuizPacks(userId: string): Promise<{ id: string; name: string; count: number }[]> {
  const { data, error } = await sb.from("sc_store_items").select("item_id").eq("user_id", userId).like("item_id", `${WORK_PREFIX}%`);
  if (error) throw error;
  const ids = (data ?? []).map((row) => workIdOf(row.item_id as string)).filter((id): id is string => Boolean(id));
  if (!ids.length) return [];
  const { data: works, error: worksError } = await sb
    .from("sc_studio_works")
    .select("id, name, kind, status, payload")
    .in("id", ids)
    .eq("kind", "quiz")
    .neq("status", "removed");
  if (worksError) throw worksError;
  return (works ?? [])
    .map((w) => ({
      id: w.id as string,
      name: w.name as string,
      count: ((w.payload as QuizPayload | null)?.questions ?? []).length
    }))
    .filter((pack) => pack.count >= QUIZ_ROUNDS_FOR_PACKS);
}

// 買った問題集から、指定の問題数だけ出す（選択肢の順番はばらす）。買っていない・足りないときは null
export async function studioQuizFromWork(userId: string, workId: string, rounds: number): Promise<{ q: string; options: string[]; answer: number }[] | null> {
  const { data: owned, error } = await sb
    .from("sc_store_items")
    .select("item_id")
    .eq("user_id", userId)
    .eq("item_id", `${WORK_PREFIX}${workId}`)
    .maybeSingle();
  if (error) throw error;
  if (!owned) return null;
  const { data: work, error: workError } = await sb.from("sc_studio_works").select("kind, status, payload").eq("id", workId).maybeSingle();
  if (workError) throw workError;
  if (!work || work.kind !== "quiz" || work.status === "removed") return null;
  const questions = (work.payload as QuizPayload | null)?.questions ?? [];
  if (questions.length < rounds) return null;
  const shuffled = [...questions].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, rounds).map((item) => {
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    return { q: item.q, options: order.map((i) => item.options[i]), answer: order.indexOf(item.answer) };
  });
}

export const storeKindOf = (kind: StudioKind): StoreItem["kind"] =>
  kind === "theme" ? "theme" : kind === "stamp_pack" ? "stamp_pack" : "extension";

export function toStudioItem(row: WorkRow): StudioStoreItem {
  return {
    id: `${WORK_PREFIX}${row.id}`,
    kind: storeKindOf(row.kind),
    name: row.name,
    description: row.description,
    price: row.price,
    source: "studio",
    creatorId: row.creator_id,
    studioKind: row.kind,
    status: row.status
  };
}

// 商品IDから商品を探す。forSale のときは販売中の作品だけ（購入用）。
// 外観・応答スタイルの選び直しは、非公開や削除済みでも買った作品なら選べる（removed は除く）
export async function resolveStudioItem(itemId: string, forSale: boolean): Promise<StudioStoreItem | null> {
  const id = workIdOf(itemId);
  if (!id) return null;
  const row = await loadWork(id);
  if (!row) return null;
  if (forSale ? row.status !== "published" : row.status === "removed") return null;
  return toStudioItem(row);
}

// 作品の画像IDを、ストアの表示用にまとめて取る（作品ID → サムネイルID・スタンプIDの一覧）
export async function displayImagesFor(workIds: string[]) {
  const map = await imagesByWork(workIds);
  const result = new Map<string, { thumb: string | null; stamps: string[] }>();
  for (const id of workIds) {
    const list = map.get(id) ?? [];
    result.set(id, {
      thumb: list.find((i) => i.role === "thumb")?.id ?? null,
      stamps: list.filter((i) => i.role === "stamp").map((i) => i.id)
    });
  }
  return result;
}

// 作品の画像（サムネイル・スタンプ）の一覧。作品ごとに、順番どおりに並べる
export async function imagesByWork(workIds: string[]): Promise<Map<string, { id: string; role: string; position: number }[]>> {
  const map = new Map<string, { id: string; role: string; position: number }[]>();
  if (!workIds.length) return map;
  const { data, error } = await sb
    .from("sc_studio_images")
    .select("id, work_id, role, position")
    .in("work_id", workIds)
    .order("position", { ascending: true });
  if (error) throw error;
  for (const row of data ?? []) {
    const list = map.get(row.work_id as string) ?? [];
    list.push({ id: row.id as string, role: row.role as string, position: row.position as number });
    map.set(row.work_id as string, list);
  }
  return map;
}

// スタンプ画像の参照（studio:画像ID）を送ってよいか。作者本人か、作品を買った人だけ
export async function studioStampAllowed(imageId: string, userId: string): Promise<boolean> {
  const { data, error } = await sb.from("sc_studio_images").select("work_id, role").eq("id", imageId).maybeSingle();
  if (error) throw error;
  if (!data || data.role !== "stamp") return false;
  const row = await loadWork(data.work_id as string);
  if (!row || row.status === "removed") return false;
  if (row.creator_id === userId) return true;
  return canUseItem(userId, toStudioItem(row));
}

// 買った作品の中のミニゲーム問題集から、5問ランダムに出題する（問題集がなければ null）
export async function studioQuizFor(userId: string, rounds: number): Promise<{ q: string; options: string[]; answer: number }[] | null> {
  const { data, error } = await sb.from("sc_store_items").select("item_id").eq("user_id", userId).like("item_id", `${WORK_PREFIX}%`);
  if (error) throw error;
  const ids = (data ?? []).map((row) => workIdOf(row.item_id as string)).filter((id): id is string => Boolean(id));
  if (!ids.length) return null;
  const { data: works, error: worksError } = await sb
    .from("sc_studio_works")
    .select("id, kind, status, payload")
    .in("id", ids)
    .eq("kind", "quiz")
    .neq("status", "removed");
  if (worksError) throw worksError;
  const packs = (works ?? []).map((w) => (w.payload as QuizPayload | null)?.questions ?? []).filter((q) => q.length >= rounds);
  if (!packs.length) return null;
  const pack = packs[Math.floor(Math.random() * packs.length)];
  const shuffled = [...pack].sort(() => Math.random() - 0.5);
  // 選択肢の順番もばらす（正解の位置を付け替える）
  return shuffled.slice(0, rounds).map((item) => {
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    return {
      q: item.q,
      options: order.map((i) => item.options[i]),
      answer: order.indexOf(item.answer)
    };
  });
}

// 使っている応答スタイルの指示文（選んでいなければ空文字）
export async function aiStyleInstructionFor(userId: string): Promise<string> {
  const { data, error } = await sb.from("sc_users").select("store_ai_style").eq("id", userId).maybeSingle();
  if (error) throw error;
  const workId = workIdOf((data?.store_ai_style as string | null) ?? "");
  if (!workId) return "";
  const row = await loadWork(workId);
  if (!row || row.kind !== "ai_style" || row.status === "removed") return "";
  if (!(await canUseItem(userId, toStudioItem(row)))) return "";
  return aiStyleInstruction(row.payload as unknown as AiStylePayload);
}
