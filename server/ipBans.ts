// IP の取得と IP BAN。
// ・IP は Express の req.ip（trust proxy = 1 なので、プロキシの X-Forwarded-For から取る）。
// ・取得できないとき（req.ip が無い・unknown など）は null。登録のときは利用者に手動で入力してもらう。
// ・BAN された IP からの /api（管理者パネル・ヘルスチェックを除く）は 403 にする。
// ・BAN の一覧はメモリに持ち、30秒ごとに読み直す。管理者が変えたときはすぐ反映する。
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { sb } from "./supabase.js";

const REFRESH_MS = 30_000;
let banned = new Set<string>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

// IPv4 を IPv6 の形（::ffff:1.2.3.4）で受けたときは、普通の IPv4 の形にそろえる
export function normalizeIp(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value.startsWith("::ffff:") && isIP(value.slice(7)) === 4) value = value.slice(7);
  if (!isIP(value)) return null;
  return value;
}

// リクエストの IP。取れなければ null
export function requestIp(req: Request): string | null {
  if (!req.ip || req.ip === "unknown") return null;
  return normalizeIp(req.ip);
}

// WebSocket の接続要求から IP を取る（Express の req.ip と同じ決め方：trust proxy = 1）
export function upgradeIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const list = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  const last = list ? list.split(",").map((part) => part.trim()).filter(Boolean).pop() : undefined;
  return normalizeIp(last ?? req.socket?.remoteAddress ?? "");
}

// 手動で入力された IP（取得できなかった人が自分で入れたもの）
export function manualIp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return normalizeIp(raw);
}

export async function reloadIpBans(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const { data, error } = await sb.from("sc_ip_bans").select("ip");
      if (error) throw error;
      banned = new Set((data ?? []).map((row: { ip: string }) => row.ip));
      loadedAt = Date.now();
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

// 同期で判定する（読み込みは裏で行う。読めなかったときは前の一覧を使う＝止めない）
export function isIpBanned(ip: string | null): boolean {
  if (!ip) return false;
  if (Date.now() - loadedAt > REFRESH_MS) {
    reloadIpBans().catch((error) => console.error("[ip-ban] IP BAN の一覧を読めませんでした", error));
  }
  return banned.has(ip);
}

export async function addIpBan(ip: string, reason: string | null): Promise<void> {
  const { error } = await sb.from("sc_ip_bans").upsert({ ip, reason }, { onConflict: "ip" });
  if (error) throw error;
  banned.add(ip);
}

export async function removeIpBan(ip: string): Promise<void> {
  const { error } = await sb.from("sc_ip_bans").delete().eq("ip", ip);
  if (error) throw error;
  banned.delete(ip);
}

// 管理者と、ヘルスチェック・状態表示は止めない
const EXEMPT = ["/api/health", "/api/status", "/api/admin"];

export function ipBanGate(req: Request, res: Response, next: NextFunction) {
  const full = (req.originalUrl || req.url || "").split("?")[0];
  if (!full.startsWith("/api/") || EXEMPT.some((p) => full === p || full.startsWith(`${p}/`))) {
    next();
    return;
  }
  if (isIpBanned(requestIp(req))) {
    res.status(403).json({ error: "このネットワークからは利用できません。" });
    return;
  }
  next();
}
