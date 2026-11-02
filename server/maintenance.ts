import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { sb } from "./supabase.js";

let current = { enabled: config.maintenance.enabled, message: config.maintenance.message };

export function getMaintenanceSettings() { return { ...current }; }

export async function initializeMaintenanceSettings() {
  const { data, error } = await sb.from("sc_system_settings").select("setting_value").eq("setting_key", "maintenance").maybeSingle();
  if (error) { console.warn("メンテナンス設定をDBから読み込めませんでした。初期設定を使用します。", error.message); return; }
  const value = data?.setting_value as { enabled?: unknown; message?: unknown } | null;
  if (value && typeof value === "object") {
    current = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
      message: typeof value.message === "string" && value.message.trim() ? value.message.trim().slice(0, 500) : current.message
    };
  }
}

export async function updateMaintenanceSettings(enabled: boolean, message: string) {
  const next = { enabled, message: message.trim().slice(0, 500) || "メンテナンス中です。しばらくお待ちください。" };
  const { error } = await sb.from("sc_system_settings").upsert({ setting_key: "maintenance", setting_value: next, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });
  if (error) throw new Error("メンテナンス設定を保存できませんでした。SupabaseのSQLを適用してください。");
  current = next;
  return { ...current };
}

// メンテナンスモード（環境変数 MAINTENANCE_MODE=on で有効）
// 有効中は、利用者向けの API と画面をすべて止めて「メンテナンス中」を返す。
// 例外として次は止めない: /api/health（Render のヘルスチェック）、/api/status と /status（稼働状況）、
// 管理者パネル（/admin、/api/admin）。WebSocket の接続も止める（realtime.ts）。

const OPEN_API = new Set(["/api/health", "/api/status"]);

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);

// 画面のアクセス時に返す、単独で表示できるページ（外部ファイルを使わない）
export function maintenancePage(message: string) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex" />
    <title>メンテナンス中 | SoraChat</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body { display: grid; place-items: center; padding: 16px; background: #f4f8fc; color: #111111; font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
      main { max-width: 420px; text-align: center; }
      h1 { font-size: 22px; margin: 0 0 12px; }
      p { line-height: 1.7; margin: 0 0 20px; color: #71849a; }
      a { color: #347fb9; }
      @media (prefers-color-scheme: dark) {
        body { background: #0c0c0c; color: #f0f0f0; }
        p { color: #9aa8b8; }
        a { color: #79b9ef; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>メンテナンス中</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="/status">サービスの稼働状況を見る</a></p>
    </main>
  </body>
</html>`;
}

export function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  const path = req.path.replace(/\/+$/, "") || "/";

  if (OPEN_API.has(path) || path.startsWith("/api/admin")) return next();
  if (!current.enabled) return next();

  if (path.startsWith("/api/")) {
    res.status(503).json({ error: current.message, maintenance: true });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(503).json({ error: current.message, maintenance: true });
    return;
  }

  // 稼働状況の画面と管理者パネルの画面、画像・スクリプトなどのファイルは通す
  if (path === "/status" || path === "/admin" || path.startsWith("/admin/") || path.includes(".")) return next();

  res.status(503).set("Cache-Control", "no-store").type("html").send(maintenancePage(current.message));
}
