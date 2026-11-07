import { Router } from "express";
import { currentUserId, requireAuth } from "./auth.js";
import { UUID } from "./messages.js";
import { readImage } from "./media.js";
import { sb } from "./supabase.js";
import { stampLocked } from "./storeAccess.js";

// スタンプ。送れるのは src/stamps/ の組み込みスタンプだけ（ref は builtin:ファイル名）。
// 自分で追加する機能は廃止した。以前送られた自作スタンプ（user:ID）は、表示だけできるように画像の取得を残す。
export const stamps = Router();
stamps.use("/stamps", requireAuth);

const BUILTIN_REF = /^builtin:[^\/\\\x00-\x1f]{1,120}$/;

// 新しく送ってよいスタンプか（組み込みだけ。仙人ストアのパックは、買った人だけ送れる）
export async function stampRefOk(ref: string, userId: string): Promise<boolean> {
  if (!BUILTIN_REF.test(ref)) return false;
  return !(await stampLocked(ref, userId));
}

// 以前送られた自作スタンプの画像（表示のみ）
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
