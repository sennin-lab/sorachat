// senninstudio（作者向け）。作品の公開・削除・通報・画像の配信。
// 作者ができるのは「公開」と「削除」だけ。停止・復帰・支払いの再送は管理者（studioAdmin.ts）が行う。
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { currentUserId, requireAuth } from "./auth.js";
import { readImage, saveSniffedImage } from "./media.js";
import { sb } from "./supabase.js";
import { isLinked } from "./senninPoints.js";
import { retryCreatorPayouts } from "./studioPayout.js";
import { displayImagesFor, loadWork, WORK_PREFIX } from "./studioData.js";
import {
  checkAiStyle,
  checkBasics,
  checkPrice,
  checkQuiz,
  checkStampImage,
  checkTheme,
  checkThumbImage,
  sniffImage,
  STAMP_MAX_COUNT,
  STUDIO_KINDS,
  THUMB_MAX_BYTES,
  type StudioKind
} from "./studioRules.js";

export const studio = Router();
studio.use("/studio", requireAuth);

const DAILY_WORK_LIMIT = 20; // 1人が1日に公開できる作品数
const REPORT_HIDE_THRESHOLD = 5; // 通報が この件数たまると自動で非公開

const UUID = /^[0-9a-f-]{36}$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: THUMB_MAX_BYTES, files: STAMP_MAX_COUNT + 1 }
}).fields([
  { name: "thumb", maxCount: 1 },
  { name: "images", maxCount: STAMP_MAX_COUNT }
]);

async function ensureCreator(userId: string) {
  const { error: upsertError } = await sb
    .from("sc_studio_creators")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (upsertError) throw upsertError;
  const { data, error } = await sb.from("sc_studio_creators").select("suspended, suspended_reason").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return { suspended: Boolean(data?.suspended), reason: (data?.suspended_reason as string | null) ?? null };
}

const NEEDS_LINK = "作品を公開するには、仙人アカウントとの連携が必要です。";

// 作者の画面：自分の作品・売上・未払い
studio.get("/studio/me", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const linked = await isLinked(me);
  if (linked) await retryCreatorPayouts(me).catch((error) => console.error("[studio] 支払いの確認に失敗:", error));
  const creator = await ensureCreator(me);

  const { data: rows, error } = await sb
    .from("sc_studio_works")
    .select("id, kind, name, price, status, hidden_reason, created_at")
    .eq("creator_id", me)
    .neq("status", "removed")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const ids = (rows ?? []).map((r) => `${WORK_PREFIX}${r.id as string}`);
  const sales = new Map<string, number>();
  if (ids.length) {
    const { data: owned, error: ownedError } = await sb.from("sc_store_items").select("item_id").in("item_id", ids);
    if (ownedError) throw ownedError;
    for (const row of owned ?? []) sales.set(row.item_id as string, (sales.get(row.item_id as string) ?? 0) + 1);
  }

  const { data: payouts, error: payoutError } = await sb.from("sc_studio_payouts").select("amount, status").eq("creator_id", me);
  if (payoutError) throw payoutError;
  let earned = 0;
  let pending = 0;
  for (const p of payouts ?? []) {
    if (p.status === "paid") earned += Number(p.amount);
    if (p.status === "pending") pending += Number(p.amount);
  }

  const thumbs = await displayImagesFor(ids.map((i) => i.slice(WORK_PREFIX.length)));
  res.json({
    linked,
    suspended: creator.suspended,
    suspendedReason: creator.reason,
    earned,
    pending,
    works: (rows ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      price: r.price,
      status: r.status,
      hiddenReason: r.hidden_reason,
      sales: sales.get(`${WORK_PREFIX}${r.id as string}`) ?? 0,
      thumbUrl: thumbs.get(r.id as string)?.thumb ? `/api/studio/images/${thumbs.get(r.id as string)!.thumb}` : null,
      createdAt: r.created_at
    }))
  });
});

// 作品を公開する（審査なし。自動チェックを通ったものだけ公開される）
studio.post("/studio/works", upload, async (req, res) => {
  const me = currentUserId(res);
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => res.status(status).json({ ok: false, error, ...extra });

  if (!(await isLinked(me))) {
    fail(403, NEEDS_LINK, { needsLink: true });
    return;
  }
  const creator = await ensureCreator(me);
  if (creator.suspended) {
    fail(403, `この作者アカウントは作品の公開を停止されています。${creator.reason ? `（理由: ${creator.reason}）` : ""}`);
    return;
  }
  if (!allow(`create:${me}`, 5, 60_000)) {
    fail(429, "作品の公開が多すぎます。少し待ってからお試しください。");
    return;
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await sb
    .from("sc_studio_works")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", me)
    .gte("created_at", since);
  if (countError) throw countError;
  if ((count ?? 0) >= DAILY_WORK_LIMIT) {
    fail(429, `1日に公開できる作品は${DAILY_WORK_LIMIT}件までです。`);
    return;
  }

  const body = req.body as Record<string, string | undefined>;
  const kind = body.kind as StudioKind | undefined;
  if (!kind || !(STUDIO_KINDS as readonly string[]).includes(kind)) {
    fail(400, "作品の種類を選んでください。");
    return;
  }
  const basicsError = checkBasics(body.name, body.description ?? "");
  if (basicsError) {
    fail(400, basicsError);
    return;
  }
  const priceError = checkPrice(body.price);
  if (priceError) {
    fail(400, priceError);
    return;
  }

  let data: unknown = null;
  try {
    data = body.data ? JSON.parse(body.data) : null;
  } catch {
    fail(400, "入力の形式が正しくありません。");
    return;
  }
  let payload: Record<string, unknown> = {};
  if (kind === "theme") {
    const checked = checkTheme(data);
    if (!checked.ok) return fail(400, checked.error);
    payload = { ...checked.payload };
  } else if (kind === "quiz") {
    const checked = checkQuiz(data);
    if (!checked.ok) return fail(400, checked.error);
    payload = { ...checked.payload };
  } else if (kind === "ai_style") {
    const checked = checkAiStyle(data);
    if (!checked.ok) return fail(400, checked.error);
    payload = { ...checked.payload };
  }

  const files = (req.files ?? {}) as unknown as Record<string, Express.Multer.File[] | undefined>;
  const images = files.images ?? [];
  const thumb = files.thumb?.[0] ?? null;

  // 画像の自動チェック（形式は中身で判定する）
  const stamps: { buf: Buffer; mime: string }[] = [];
  if (kind === "stamp_pack") {
    if (images.length < 1 || images.length > STAMP_MAX_COUNT) {
      fail(400, `スタンプは1〜${STAMP_MAX_COUNT}枚にしてください。`);
      return;
    }
    for (const file of images) {
      const error = checkStampImage(file.buffer);
      if (error) return fail(400, error);
      stamps.push({ buf: file.buffer, mime: `image/${sniffImage(file.buffer)!.type}` });
    }
  } else if (images.length) {
    fail(400, "スタンプ画像は「スタンプパック」の作品だけに付けられます。");
    return;
  }
  if (thumb) {
    const error = checkThumbImage(thumb.buffer);
    if (error) return fail(400, error);
  } else if (kind !== "stamp_pack") {
    fail(400, "サムネイル画像を選んでください。");
    return;
  }
  const thumbMime = thumb ? `image/${sniffImage(thumb.buffer)!.type}` : null;

  const id = randomUUID();
  const { error: insertError } = await sb.from("sc_studio_works").insert({
    id,
    creator_id: me,
    kind,
    name: body.name!.trim(),
    description: (body.description ?? "").trim(),
    price: Number(body.price),
    status: "published",
    payload
  });
  if (insertError) throw insertError;

  const rows: { work_id: string; role: "thumb" | "stamp"; position: number; path: string }[] = [];
  let firstStampPath: string | null = null;
  for (const [index, stamp] of stamps.entries()) {
    const path = await saveSniffedImage(stamp.buf, stamp.mime, "studio");
    if (index === 0) firstStampPath = path;
    rows.push({ work_id: id, role: "stamp", position: index, path });
  }
  if (thumb && thumbMime) {
    rows.push({ work_id: id, role: "thumb", position: 0, path: await saveSniffedImage(thumb.buffer, thumbMime, "studio") });
  } else if (firstStampPath) {
    // スタンプパックにサムネイルがなければ、1枚目をサムネイルにする
    rows.push({ work_id: id, role: "thumb", position: 0, path: firstStampPath });
  }
  const { error: imageError } = await sb.from("sc_studio_images").insert(rows);
  if (imageError) throw imageError;

  res.status(201).json({ ok: true, id });
});

// 作者が作品を削除する（販売をやめる。すでに買った人は引き続き使える）
studio.delete("/studio/works/:id", async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ ok: false, error: "作品が見つかりません。" });
    return;
  }
  const row = await loadWork(id);
  if (!row || row.creator_id !== me || row.status === "removed") {
    res.status(404).json({ ok: false, error: "作品が見つかりません。" });
    return;
  }
  const { error } = await sb
    .from("sc_studio_works")
    .update({ status: "deleted", hidden_reason: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  res.json({ ok: true });
});

// 通報（1人1作品1回。5件たまると自動で非公開）
studio.post("/studio/works/:id/report", async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) : "";
  if (!UUID.test(id)) {
    res.status(404).json({ ok: false, error: "作品が見つかりません。" });
    return;
  }
  if (!allow(`report:${me}`, 20, 60 * 60_000)) {
    res.status(429).json({ ok: false, error: "通報が多すぎます。時間をおいてお試しください。" });
    return;
  }
  const row = await loadWork(id);
  if (!row || row.status !== "published") {
    res.status(404).json({ ok: false, error: "作品が見つかりません。" });
    return;
  }
  if (row.creator_id === me) {
    res.status(400).json({ ok: false, error: "自分の作品は通報できません。" });
    return;
  }
  const { error } = await sb
    .from("sc_studio_reports")
    .upsert({ work_id: id, reporter_id: me, reason }, { onConflict: "work_id,reporter_id", ignoreDuplicates: true });
  if (error) throw error;

  const { count, error: countError } = await sb
    .from("sc_studio_reports")
    .select("reporter_id", { count: "exact", head: true })
    .eq("work_id", id);
  if (countError) throw countError;
  if ((count ?? 0) >= REPORT_HIDE_THRESHOLD) {
    await sb
      .from("sc_studio_works")
      .update({ status: "hidden", hidden_reason: "reports", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "published");
  }
  res.json({ ok: true });
});

// 作品の画像（サムネイル・スタンプ）。ログインしている人だけが見られる
studio.get("/studio/images/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).end();
    return;
  }
  const { data, error } = await sb.from("sc_studio_images").select("path, work_id").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).end();
    return;
  }
  const work = await loadWork(data.work_id as string);
  if (!work || work.status === "removed") {
    res.status(404).end();
    return;
  }
  const image = await readImage(data.path as string);
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader("content-type", image.type);
  res.setHeader("cache-control", "private, max-age=86400");
  res.send(image.buffer);
});

// 1人あたりの連打防止（時間枠の中で max 回まで）
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

