// 拡張機能のデータ保存（無料）。保存先は「仙人アカウント × 拡張機能」ごと。
// 使えるのは、拡張機能を買っている（作者本人も可）・情報の許可をしている・仙人アカウントと連携している人だけ。
import { Router } from "express";
import { currentUserId, requireAuth } from "./auth.js";
import { UUID } from "./messages.js";
import { isLinked, withLock } from "./senninPoints.js";
import { canUseItem } from "./storeAccess.js";
import { checkKey, checkValue, STORAGE } from "./extensionStorageRules.js";
import { loadWork, toStudioItem } from "./studioData.js";
import { sb } from "./supabase.js";

export const extensionStorage = Router();
extensionStorage.use("/studio/extensions", requireAuth);

export class StorageError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 1分あたりの書き込み回数（メモリ上）
const writeHits = new Map<string, number[]>();
function writeAllowed(userId: string): boolean {
  const now = Date.now();
  const recent = (writeHits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= STORAGE.writesPerMinute) {
    writeHits.set(userId, recent);
    return false;
  }
  recent.push(now);
  writeHits.set(userId, recent);
  return true;
}

// 使ってよいかを確かめて、保存先の仙人アカウントの ID を返す
async function gate(userId: string, workId: string): Promise<string> {
  if (!UUID.test(workId)) throw new StorageError(404, "not_found", "拡張機能が見つかりません。");
  const work = await loadWork(workId);
  if (!work || work.kind !== "extension" || work.status === "removed") {
    throw new StorageError(404, "not_found", "拡張機能が見つかりません。");
  }
  if (work.creator_id !== userId && !(await canUseItem(userId, toStudioItem(work)))) {
    throw new StorageError(403, "not_owned", "この拡張機能はまだ購入していません。");
  }
  if (!(await isLinked(userId))) {
    throw new StorageError(403, "not_linked", "データを保存するには、仙人アカウントとの連携が必要です。");
  }
  const { data: user, error: userError } = await sb.from("sc_users").select("sennin_id").eq("id", userId).maybeSingle();
  if (userError) throw userError;
  const senninId = (user?.sennin_id as string | null) ?? null;
  if (!senninId) throw new StorageError(403, "not_linked", "データを保存するには、仙人アカウントとの連携が必要です。");
  return senninId;
}

export async function listKeys(userId: string, workId: string): Promise<string[]> {
  const senninId = await gate(userId, workId);
  const { data, error } = await sb
    .from("sc_extension_data")
    .select("key")
    .eq("sennin_id", senninId)
    .eq("work_id", workId)
    .order("key", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => String(row.key));
}

export async function readValue(userId: string, workId: string, key: string): Promise<unknown | null> {
  const senninId = await gate(userId, workId);
  const { data, error } = await sb
    .from("sc_extension_data")
    .select("value")
    .eq("sennin_id", senninId)
    .eq("work_id", workId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

export async function writeValue(userId: string, workId: string, key: string, value: unknown): Promise<void> {
  if (!writeAllowed(userId)) throw new StorageError(429, "rate_limited", "保存が多すぎます。少し待ってからお試しください。");
  const senninId = await gate(userId, workId);
  await withLock(`ext-data:${senninId}:${workId}`, async () => {
    const { count, error: countError } = await sb
      .from("sc_extension_data")
      .select("key", { count: "exact", head: true })
      .eq("sennin_id", senninId)
      .eq("work_id", workId);
    if (countError) throw countError;
    const { data: existing, error: existError } = await sb
      .from("sc_extension_data")
      .select("key")
      .eq("sennin_id", senninId)
      .eq("work_id", workId)
      .eq("key", key)
      .maybeSingle();
    if (existError) throw existError;
    if (!existing && (count ?? 0) >= STORAGE.keysMax) {
      throw new StorageError(409, "full", `保存できるのは ${STORAGE.keysMax} 件までです。使わない項目を消してください。`);
    }
    const { error } = await sb.from("sc_extension_data").upsert(
      { sennin_id: senninId, work_id: workId, key, value, updated_at: new Date().toISOString() },
      { onConflict: "sennin_id,work_id,key" }
    );
    if (error) throw error;
  });
}

export async function removeValue(userId: string, workId: string, key: string): Promise<void> {
  if (!writeAllowed(userId)) throw new StorageError(429, "rate_limited", "保存が多すぎます。少し待ってからお試しください。");
  const senninId = await gate(userId, workId);
  const { error } = await sb.from("sc_extension_data").delete().eq("sennin_id", senninId).eq("work_id", workId).eq("key", key);
  if (error) throw error;
}

function fail(res: import("express").Response, error: unknown) {
  if (error instanceof StorageError) {
    res.status(error.status).json({ ok: false, error: error.message, code: error.code });
    return;
  }
  throw error;
}

extensionStorage.get("/studio/extensions/:id/storage", async (req, res) => {
  try {
    res.json({ ok: true, keys: await listKeys(currentUserId(res), String(req.params.id)) });
  } catch (error) {
    fail(res, error);
  }
});

extensionStorage.get("/studio/extensions/:id/storage/:key", async (req, res) => {
  const key = String(req.params.key);
  const keyError = checkKey(key);
  if (keyError) {
    res.status(400).json({ ok: false, error: keyError, code: "invalid" });
    return;
  }
  try {
    res.json({ ok: true, value: await readValue(currentUserId(res), String(req.params.id), key) });
  } catch (error) {
    fail(res, error);
  }
});

extensionStorage.put("/studio/extensions/:id/storage/:key", async (req, res) => {
  const key = String(req.params.key);
  const keyError = checkKey(key);
  if (keyError) {
    res.status(400).json({ ok: false, error: keyError, code: "invalid" });
    return;
  }
  const valueCheck = checkValue((req.body as { value?: unknown } | undefined)?.value);
  if (!valueCheck.ok) {
    res.status(400).json({ ok: false, error: valueCheck.error, code: "invalid" });
    return;
  }
  try {
    await writeValue(currentUserId(res), String(req.params.id), key, (req.body as { value: unknown }).value);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error);
  }
});

extensionStorage.delete("/studio/extensions/:id/storage/:key", async (req, res) => {
  const key = String(req.params.key);
  const keyError = checkKey(key);
  if (keyError) {
    res.status(400).json({ ok: false, error: keyError, code: "invalid" });
    return;
  }
  try {
    await removeValue(currentUserId(res), String(req.params.id), key);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error);
  }
});
