// senninstudio のレビュー（星とコメント）・作者の評価・商品の詳細・作者のページ。
// レビューは、その作品を買った人だけが付けられる（作者本人は不可）。1人1作品1件。
// 作者の評価は、作者の全作品（削除・運営の削除を除く）のレビューをまとめたもの。
import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { sb } from "./supabase.js";
import { checkText, type AiStylePayload, type QuizPayload, type ThemePayload } from "./studioRules.js";
import { imagesByWork, loadWork, WORK_PREFIX } from "./studioData.js";

export const studioReviews = Router();

const UUID = /^[0-9a-f-]{36}$/i;
const round1 = (n: number) => Math.round(n * 10) / 10;

export type RatingSummary = { avg: number; count: number; distribution: number[] };
type RawRating = { sum: number; count: number; distribution: number[] };

const toSummary = (raw?: RawRating): RatingSummary =>
  raw && raw.count > 0
    ? { avg: round1(raw.sum / raw.count), count: raw.count, distribution: raw.distribution }
    : { avg: 0, count: 0, distribution: [0, 0, 0, 0, 0] };

// 作品ごとの星の合計・件数・星ごとの件数（まとめて1回の問い合わせ）
async function rawRatings(workIds: string[]): Promise<Map<string, RawRating>> {
  const map = new Map<string, RawRating>();
  if (!workIds.length) return map;
  const { data, error } = await sb.from("sc_studio_reviews").select("work_id, rating").in("work_id", workIds);
  if (error) throw error;
  for (const row of data ?? []) {
    const id = row.work_id as string;
    const rating = Number(row.rating);
    const raw = map.get(id) ?? { sum: 0, count: 0, distribution: [0, 0, 0, 0, 0] };
    raw.sum += rating;
    raw.count += 1;
    raw.distribution[rating - 1] += 1;
    map.set(id, raw);
  }
  return map;
}

// 作品の評価（平均・件数・星ごとの件数）
export async function ratingsByWork(workIds: string[]): Promise<Map<string, RatingSummary>> {
  const raw = await rawRatings(workIds);
  const map = new Map<string, RatingSummary>();
  for (const id of workIds) map.set(id, toSummary(raw.get(id)));
  return map;
}

// 作品ごとの販売数（買った人の数）
export async function salesByWork(workIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!workIds.length) return map;
  const { data, error } = await sb
    .from("sc_store_items")
    .select("item_id")
    .in(
      "item_id",
      workIds.map((id) => `${WORK_PREFIX}${id}`)
    );
  if (error) throw error;
  for (const row of data ?? []) {
    const id = (row.item_id as string).slice(WORK_PREFIX.length);
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

// 作者の作品の、id と状態だけ（削除・運営の削除を除く）。詳細ページでは中身を読まずに数えるだけにする
async function creatorWorkStatuses(creatorId: string): Promise<{ id: string; status: string }[]> {
  const { data, error } = await sb
    .from("sc_studio_works")
    .select("id, status")
    .eq("creator_id", creatorId)
    .neq("status", "removed")
    .limit(300);
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id as string, status: row.status as string }));
}

// 作者の全作品（削除・運営の削除を除く）。作者のページで中身も使う
async function creatorWorks(creatorId: string) {
  const { data, error } = await sb
    .from("sc_studio_works")
    .select("id, kind, name, description, price, status, payload, created_at, edited_at")
    .eq("creator_id", creatorId)
    .neq("status", "removed")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return data ?? [];
}

// 作者の評価（全作品のレビューをまとめる）
async function creatorRating(workIds: string[]): Promise<RatingSummary> {
  const raw = await rawRatings(workIds);
  const merged: RawRating = { sum: 0, count: 0, distribution: [0, 0, 0, 0, 0] };
  for (const r of raw.values()) {
    merged.sum += r.sum;
    merged.count += r.count;
    r.distribution.forEach((n, i) => (merged.distribution[i] += n));
  }
  return toSummary(merged);
}

async function namesById(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (!unique.length) return map;
  const { data, error } = await sb.from("sc_users").select("id, display_name").in("id", unique);
  if (error) throw error;
  for (const row of data ?? []) map.set(row.id as string, row.display_name as string);
  return map;
}

// 自分がこの作品を買ったか（作者本人は「買った」扱いにしない。買ったときだけ true）
async function ownsWork(userId: string, workId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("sc_store_items")
    .select("item_id")
    .eq("user_id", userId)
    .eq("item_id", `${WORK_PREFIX}${workId}`)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

type ReviewRow = {
  reviewerId: string;
  reviewerName: string;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
};

async function reviewsOf(workId: string, me: string, limit: number): Promise<ReviewRow[]> {
  const { data, error } = await sb
    .from("sc_studio_reviews")
    .select("reviewer_id, rating, comment, created_at, updated_at")
    .eq("work_id", workId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = data ?? [];
  const names = await namesById(rows.map((r) => r.reviewer_id as string));
  return rows.map((r) => ({
    reviewerId: r.reviewer_id as string,
    reviewerName: names.get(r.reviewer_id as string) ?? "",
    rating: Number(r.rating),
    comment: (r.comment as string) ?? "",
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    mine: r.reviewer_id === me
  }));
}

const notFound = (res: import("express").Response) => res.status(404).json({ ok: false, error: "作品が見つかりません。" });

// 商品の詳細（掲載ページ）。販売中の作品は誰でも見られる。非公開・削除済みは、買った人と作者だけ
studioReviews.get("/store/items/:id", requireAuth, async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  if (!UUID.test(id)) return notFound(res);
  const work = await loadWork(id);
  if (!work || work.status === "removed") return notFound(res);

  const isMine = work.creator_id === me;
  const owned = await ownsWork(me, id);
  if (work.status !== "published" && !owned && !isMine) return notFound(res);

  const [creatorName, images, raw, sales, reviews, creatorWorkRows] = await Promise.all([
    namesById([work.creator_id]),
    imagesByWork([id]),
    rawRatings([id]),
    salesByWork([id]),
    reviewsOf(id, me, 100),
    creatorWorkStatuses(work.creator_id)
  ]);
  const creator = await creatorRating(creatorWorkRows.map((w) => w.id));

  const list = images.get(id) ?? [];
  const thumb = list.find((i) => i.role === "thumb");
  const stamps = list.filter((i) => i.role === "stamp");
  const payload = (work.payload ?? {}) as Record<string, unknown>;

  res.set("Cache-Control", "no-store");
  res.json({
    id,
    kind: work.kind,
    name: work.name,
    description: work.description,
    price: Number(work.price),
    status: work.status,
    createdAt: work.created_at,
    editedAt: work.edited_at ?? null,
    sales: sales.get(id) ?? 0,
    thumbUrl: thumb ? `/api/studio/images/${thumb.id}` : null,
    stamps: stamps.map((s) => `/api/studio/images/${s.id}`),
    // 配色・応答スタイルは見本として公開する。問題の中身（答え）は買うまで見せない（問題数だけ）
    palette: work.kind === "theme" ? (payload as Partial<ThemePayload>) : null,
    aiStyle: work.kind === "ai_style" ? (payload as Partial<AiStylePayload>) : null,
    quizCount: work.kind === "quiz" ? ((payload as Partial<QuizPayload>).questions?.length ?? 0) : null,
    rating: toSummary(raw.get(id)),
    reviews,
    myReview: reviews.find((r) => r.mine) ?? null,
    owned,
    isMine,
    canReview: owned && !isMine,
    creator: {
      id: work.creator_id,
      name: creatorName.get(work.creator_id) ?? "",
      rating: creator,
      workCount: creatorWorkRows.filter((w) => w.status === "published").length
    }
  });
});

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000)
});

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

// レビューを書く・直す（買った人だけ。同じ人の2回目は内容を置き換える）
studioReviews.post("/studio/works/:id/review", requireAuth, async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  if (!UUID.test(id)) return notFound(res);
  const parsed = reviewSchema.safeParse({
    rating: typeof req.body?.rating === "string" ? Number(req.body.rating) : req.body?.rating,
    comment: typeof req.body?.comment === "string" ? req.body.comment.trim() : ""
  });
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "星は1〜5で選んでください。コメントは1000文字までです。" });
    return;
  }
  const textError = parsed.data.comment ? checkText(parsed.data.comment, "レビュー") : null;
  if (textError) {
    res.status(400).json({ ok: false, error: textError });
    return;
  }
  const work = await loadWork(id);
  if (!work || work.status === "removed") return notFound(res);
  if (work.creator_id === me) {
    res.status(400).json({ ok: false, error: "自分の作品にはレビューできません。" });
    return;
  }
  if (!(await ownsWork(me, id))) {
    res.status(403).json({ ok: false, error: "レビューは、この作品を買った人だけが書けます。" });
    return;
  }
  if (!allow(`review:${me}`, 20, 60 * 60_000)) {
    res.status(429).json({ ok: false, error: "レビューの投稿が多すぎます。時間をおいてお試しください。" });
    return;
  }
  const { error } = await sb.from("sc_studio_reviews").upsert(
    {
      work_id: id,
      reviewer_id: me,
      rating: parsed.data.rating,
      comment: parsed.data.comment,
      updated_at: new Date().toISOString()
    },
    { onConflict: "work_id,reviewer_id" }
  );
  if (error) throw error;
  res.json({ ok: true });
});

// 自分のレビューを消す
studioReviews.delete("/studio/works/:id/review", requireAuth, async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  if (!UUID.test(id)) return notFound(res);
  const { error } = await sb.from("sc_studio_reviews").delete().eq("work_id", id).eq("reviewer_id", me);
  if (error) throw error;
  res.json({ ok: true });
});

// 作者のページ（評価・販売中の作品・最近のレビュー）
studioReviews.get("/studio/creators/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) return notFound(res);
  const { data: user, error: userError } = await sb
    .from("sc_users")
    .select("id, display_name, created_at")
    .eq("id", id)
    .maybeSingle();
  if (userError) throw userError;
  if (!user) return notFound(res);

  const all = await creatorWorks(id);
  const allIds = all.map((w) => w.id as string);
  const published = all.filter((w) => w.status === "published");
  const publishedIds = published.map((w) => w.id as string);
  const [raw, sales, creator, images] = await Promise.all([
    rawRatings(allIds),
    salesByWork(allIds),
    creatorRating(allIds),
    imagesByWork(publishedIds)
  ]);

  // 最近のレビュー（全作品から新しい順に30件）
  let recent: { work_id: string; reviewer_id: string; rating: number; comment: string; updated_at: string }[] = [];
  if (allIds.length) {
    const { data, error } = await sb
      .from("sc_studio_reviews")
      .select("work_id, reviewer_id, rating, comment, updated_at")
      .in("work_id", allIds)
      .order("updated_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    recent = (data ?? []) as typeof recent;
  }
  const names = await namesById(recent.map((r) => r.reviewer_id));
  const workNames = new Map(all.map((w) => [w.id as string, w.name as string]));

  const totalSales = allIds.reduce((sum, workId) => sum + (sales.get(workId) ?? 0), 0);
  res.set("Cache-Control", "no-store");
  res.json({
    id,
    name: user.display_name as string,
    createdAt: user.created_at as string,
    rating: creator,
    workCount: published.length,
    sales: totalSales,
    works: published.map((w) => {
      const workId = w.id as string;
      const list = images.get(workId) ?? [];
      const thumb = list.find((i) => i.role === "thumb");
      return {
        id: workId,
        kind: w.kind,
        name: w.name,
        price: Number(w.price),
        rating: toSummary(raw.get(workId)),
        sales: sales.get(workId) ?? 0,
        thumbUrl: thumb ? `/api/studio/images/${thumb.id}` : null
      };
    }),
    reviews: recent.map((r) => ({
      workId: r.work_id,
      workName: workNames.get(r.work_id) ?? "",
      reviewerName: names.get(r.reviewer_id) ?? "",
      rating: Number(r.rating),
      comment: r.comment ?? "",
      updatedAt: r.updated_at
    }))
  });
});

