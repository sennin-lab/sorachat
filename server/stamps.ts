import { Router } from "express";
import { currentUserId, requireAuth } from "./auth.js";
import { UUID } from "./messages.js";
import { isAllowedImage, readImage, removeImage, saveImage, upload } from "./media.js";
import { sb } from "./supabase.js";

// スタンプ。組み込みは src/stamps/ の画像（ref は builtin:ファイル名）、自分でアップロードしたものは
// sc_user_stamps に入れる（ref は user:ID）。画像メッセージとは別の種類として送る。
export const stamps = Router();
stamps.use("/stamps", requireAuth);

const MAX_USER_STAMPS = 100;
const BUILTIN_REF = /^builtin:[a-z0-9_-]{1,60}\.(png|webp|gif|jpe?g|svg)$/i;

// 送ってよいスタンプか（組み込みは名前の形だけ、自分のものは持ち主を確かめる）
export async function stampRefOk(ref: string, userId: string): Promise<boolean> {
  if (BUILTIN_REF.test(ref)) return true;
  const match = ref.match(/^user:([0-9a-f-]{36})$/i);
  if (!match || !UUID.test(match[1])) return false;
  const { data, error } = await sb.from("sc_user_stamps").select("id").eq("id", match[1]).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

stamps.get("/stamps", async (_req, res) => {
  const me = currentUserId(res);
  const { data, error } = await sb.from("sc_user_stamps").select("id").eq("user_id", me).order("created_at", { ascending: false });
  if (error) throw error;
  res.json({
    stamps: ((data ?? []) as { id: string }[]).map((s) => ({ ref: `user:${s.id}`, id: s.id, url: `/api/stamps/${s.id}/image` }))
  });
});

stamps.post("/stamps", upload.single("file"), async (req, res) => {
  const me = currentUserId(res);
  if (!isAllowedImage(req.file)) {
    res.status(415).json({ error: "JPEG・PNG・WebP・GIF の画像を選んでください。" });
    return;
  }
  const { count, error: countError } = await sb
    .from("sc_user_stamps")
    .select("id", { count: "exact", head: true })
    .eq("user_id", me);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_USER_STAMPS) {
    res.status(400).json({ error: `スタンプは${MAX_USER_STAMPS}個までです。不要なものを削除してください。` });
    return;
  }
  const path = await saveImage(req.file!, `stamps/${me}`);
  const { data, error } = await sb.from("sc_user_stamps").insert({ user_id: me, path }).select("id").single();
  if (error) throw error;
  const id = (data as { id: string }).id;
  res.status(201).json({ ref: `user:${id}`, id, url: `/api/stamps/${id}/image` });
});

// 画像は、ID を知っていれば表示できる（ID は推測されにくい UUID）
stamps.get("/stamps/:id/image", async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ error: "スタンプが見つかりません。" });
    return;
  }
  const { data, error } = await sb.from("sc_user_stamps").select("path").eq("id", id).maybeSingle();
  if (error) throw error;
  const image = data ? await readImage((data as { path: string }).path) : null;
  if (!image) {
    res.status(404).json({ error: "スタンプが見つかりません。" });
    return;
  }
  res.setHeader("content-type", image.type);
  res.setHeader("cache-control", "private, max-age=86400");
  res.send(image.buffer);
});

stamps.delete("/stamps/:id", async (req, res) => {
  const me = currentUserId(res);
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ error: "スタンプが見つかりません。" });
    return;
  }
  const { data, error } = await sb.from("sc_user_stamps").select("path").eq("id", id).eq("user_id", me).maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "スタンプが見つかりません。" });
    return;
  }
  const { error: deleteError } = await sb.from("sc_user_stamps").delete().eq("id", id).eq("user_id", me);
  if (deleteError) throw deleteError;
  await removeImage((data as { path: string }).path);
  res.json({ ok: true });
});
