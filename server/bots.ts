import { Router } from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, currentUserId } from "./auth.js";
import { sb } from "./supabase.js";
import { avatarVersionOf } from "./avatarVersion.js";

export const bots = Router();

const here = path.dirname(fileURLToPath(import.meta.url));
const botsHtmlPath = path.resolve(here, "..", "public", "bots.html");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// 使うモデルの候補。先頭は GROQ_MODEL（環境変数）。モデルが無い・使えないとき（404など）は次の候補へ切り替える
// Groq はモデルの入れ替えが多いので、console.groq.com/docs/models の一覧に合わせて調整してください
const GROQ_MODEL_CANDIDATES = [
  process.env.GROQ_MODEL?.trim(),
  "llama-3.3-70b-versatile",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3-32b",
  "llama-3.1-8b-instant"
].filter((m, i, all): m is string => Boolean(m) && all.indexOf(m) === i);

// 一度動いたモデルは覚えておき、次回からそれを先に使う
let workingModel: string | null = null;

// 環境変数の前後の空白や引用符を取り除く（config.ts と同じ扱い）
function groqKey(): string {
  let value = (process.env.GROQ_API_KEY ?? "").trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

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

async function isLinked(userId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("sc_bots_links")
    .select("allowed")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.allowed === true;
}

// ---- /bots の画面（SoraChat の画面からはリンクしない） ----
bots.get("/bots", (_req: Request, res: Response) => {
  res.setHeader("Content-Security-Policy", BOTS_CSP);
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(botsHtmlPath, (error) => {
    if (error && !res.headersSent) res.status(404).send("Not found");
  });
});

// ---- ログイン中の SoraChat アカウント（アイコンと名前の表示用） ----
bots.get("/api/bots/me", requireAuth, async (_req: Request, res: Response) => {
  const userId = currentUserId(res);
  const { data, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, avatar_path")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "アカウントが見つかりません。" });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json({
    username: data.username as string,
    displayName: data.display_name as string,
    avatarUrl: data.avatar_path
      ? `/api/users/${data.id}/avatar?v=${avatarVersionOf(data.avatar_path as string)}`
      : null
  });
});

// ---- SoraChat 連携の状態 ----
bots.get("/api/bots/link", requireAuth, async (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  res.json({ allowed: await isLinked(currentUserId(res)) });
});

bots.post("/api/bots/link", requireAuth, async (req: Request, res: Response) => {
  const allowed = req.body?.allowed === true;
  const { error } = await sb
    .from("sc_bots_links")
    .upsert({ user_id: currentUserId(res), allowed, updated_at: new Date().toISOString() });
  if (error) throw error;
  res.json({ allowed });
});

// ---- 会話（連携済みのユーザーだけ。Groq へ中継） ----
bots.post("/api/bots/chat", requireAuth, async (req: Request, res: Response) => {
  if (!(await isLinked(currentUserId(res)))) {
    res.status(403).json({ error: "Botsを使うにはSoraChatと連携してください。", needsLink: true });
    return;
  }

  const apiKey = groqKey();
  if (!apiKey) {
    res.status(503).json({ error: "AIの設定に問題があります。管理者に連絡してください。" });
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

  try {
    const messagesForAi = [
      { role: "system", content: `${SYSTEM_BASE}\n\n${SORACHAT_CONTEXT}` },
      ...history,
      { role: "user", content: message }
    ];

    // 候補のモデルを順に試す。モデルが使えない（404 / model_not_found）ときだけ次へ
    const order = workingModel
      ? [workingModel, ...GROQ_MODEL_CANDIDATES.filter((m) => m !== workingModel)]
      : GROQ_MODEL_CANDIDATES;

    let upstream: globalThis.Response | null = null;
    let usedModel = "";
    for (const model of order) {
      const attempt = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages: messagesForAi, temperature: 0.6, max_tokens: 1024 }),
        signal: AbortSignal.timeout(30_000)
      });

      if (attempt.status === 404 || attempt.status === 400) {
        const detail = await attempt.text();
        if (/model/i.test(detail)) {
          console.error(`Groq model unavailable: ${model}`, detail.slice(0, 200));
          continue;
        }
        upstream = new globalThis.Response(detail, { status: attempt.status });
        break;
      }

      upstream = attempt;
      usedModel = model;
      break;
    }

    if (!upstream) {
      console.error("No usable Groq model. Tried:", order.join(", "));
      res.status(503).json({ error: "AIの設定に問題があります。管理者に連絡してください。" });
      return;
    }

    if (upstream.status === 401 || upstream.status === 403) {
      // キーが無効。利用者に原因は見せず、サーバーのログにだけ残す
      console.error("Groq API key rejected", upstream.status, (await upstream.text()).slice(0, 300));
      res.status(503).json({ error: "AIの設定に問題があります。管理者に連絡してください。" });
      return;
    }

    if (!upstream.ok) {
      console.error("Groq API error", upstream.status, (await upstream.text()).slice(0, 300));
      res.status(502).json({ error: "AIが応答できませんでした。少し待ってからもう一度お試しください。" });
      return;
    }

    if (usedModel) workingModel = usedModel;

    const data: any = await upstream.json();
    const reply = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!reply) {
      res.status(502).json({ error: "AIの回答を読めませんでした。" });
      return;
    }

    res.json({ reply });
  } catch (error) {
    console.error("Bots chat failed", error);
    res.status(502).json({ error: "AIへの接続に失敗しました。" });
  }
});
