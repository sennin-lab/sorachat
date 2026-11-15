import { Router } from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, currentUserId } from "./auth.js";
import { sb } from "./supabase.js";

export const bots = Router();

const here = path.dirname(fileURLToPath(import.meta.url));
const botsHtmlPath = path.resolve(here, "..", "public", "bots.html");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// 無料枠で使えるモデル名は変わることがあるので、環境変数で差し替えられるようにしています
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// bots.html はインラインの script と style を使うため、このページだけ CSP を緩めます
const BOTS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
  "connect-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join("; ");

// SoraChat の連携を許可したユーザーにだけ渡す、公開情報の要約
// パスワード・トークン・他人のDMなどは含めない
const SORACHAT_CONTEXT = `
SoraChat はDM専用のチャットアプリです。
- ユーザー名とパスワードで登録・ログインできる（仙人アカウントでの続行も可能）
- 通知（Web Push）、グループDM、リアクション、ノート、返信、既読に対応
- 拡張機能（ストア）があり、ポイントの配布や対戦などに使える
- 仙人Tube Plus（/tube）が組み込まれている
このアプリについて聞かれたら上の内容で答えてください。ユーザーの個人情報や他人のメッセージにはアクセスできません。
`.trim();

const SYSTEM_BASE = `
あなたは「Bots」というAIアシスタントです。日本語で、わかりやすく簡潔に答えてください。
金融商品の売買を自動で行うことはできません。投資の話題では、一般的な情報とリスクを伝え、最終判断はユーザーに任せてください。
`.trim();

type ChatTurn = { role: "user" | "assistant"; content: string };

// ---- /bots の画面（SoraChat の画面からはリンクしない） ----
bots.get("/bots", (_req: Request, res: Response) => {
  res.setHeader("Content-Security-Policy", BOTS_CSP);
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(botsHtmlPath, (error) => {
    if (error && !res.headersSent) res.status(404).send("Not found");
  });
});

// ---- SoraChat 連携の状態 ----
bots.get("/api/bots/link", requireAuth, async (_req: Request, res: Response) => {
  const { data, error } = await sb
    .from("sc_bots_links")
    .select("allowed")
    .eq("user_id", currentUserId(res))
    .maybeSingle();
  if (error) throw error;
  res.json({ allowed: data?.allowed === true });
});

bots.post("/api/bots/link", requireAuth, async (req: Request, res: Response) => {
  const allowed = req.body?.allowed === true;
  const { error } = await sb
    .from("sc_bots_links")
    .upsert({ user_id: currentUserId(res), allowed, updated_at: new Date().toISOString() });
  if (error) throw error;
  res.json({ allowed });
});

// ---- 会話（Groq へ中継） ----
bots.post("/api/bots/chat", requireAuth, async (req: Request, res: Response) => {
  const apiKey = (process.env.GROQ_API_KEY ?? "").trim();
  if (!apiKey) {
    res.status(503).json({ error: "Bots の AI キーが設定されていません。管理者に連絡してください。" });
    return;
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 4000) : "";
  if (!message) {
    res.status(400).json({ error: "メッセージを入力してください。" });
    return;
  }

  // クライアントから来た履歴は形を整える（直近10件まで）
  const history: ChatTurn[] = Array.isArray(req.body?.history)
    ? req.body.history
        .slice(-10)
        .filter((h: any) => (h?.role === "user" || h?.role === "assistant") && typeof h?.content === "string")
        .map((h: any) => ({ role: h.role as ChatTurn["role"], content: String(h.content).slice(0, 4000) }))
    : [];

  const { data: link, error: linkError } = await sb
    .from("sc_bots_links")
    .select("allowed")
    .eq("user_id", currentUserId(res))
    .maybeSingle();
  if (linkError) throw linkError;
  const linked = link?.allowed === true;

  const system = linked ? `${SYSTEM_BASE}\n\n${SORACHAT_CONTEXT}` : SYSTEM_BASE;

  try {
    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "system", content: system }, ...history, { role: "user", content: message }],
        temperature: 0.6,
        max_tokens: 1024
      }),
      signal: AbortSignal.timeout(30_000)
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("Groq API error", upstream.status, detail.slice(0, 300));
      res.status(502).json({ error: "AIが応答できませんでした。少し待ってからもう一度お試しください。" });
      return;
    }

    const data: any = await upstream.json();
    const reply = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!reply) {
      res.status(502).json({ error: "AIの回答を読めませんでした。" });
      return;
    }

    res.json({ reply, linked });
  } catch (error) {
    console.error("Bots chat failed", error);
    res.status(502).json({ error: "AIへの接続に失敗しました。" });
  }
});
