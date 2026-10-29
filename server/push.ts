import { Router } from "express";
import webpush from "web-push";
import { z } from "zod";
import { config } from "./config.js";
import { currentUserId, requireAuth } from "./auth.js";
import { sb } from "./supabase.js";

export const push = Router();

export const pushEnabled = Boolean(config.vapid.publicKey && config.vapid.privateKey);

if (pushEnabled) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
}

push.get("/push/public-key", (_req, res) => {
  res.json({ enabled: pushEnabled, publicKey: pushEnabled ? config.vapid.publicKey : null });
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048).startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) })
});

push.post("/push/subscribe", requireAuth, async (req, res) => {
  if (!pushEnabled) {
    res.status(503).json({ error: "通知は現在利用できません。" });
    return;
  }
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "通知の登録情報が正しくありません。" });
    return;
  }
  const { error } = await sb.from("sc_push_subscriptions").upsert(
    {
      endpoint: parsed.data.endpoint,
      user_id: currentUserId(res),
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth
    },
    { onConflict: "endpoint" }
  );
  if (error) throw error;
  res.json({ ok: true });
});

push.post("/push/unsubscribe", requireAuth, async (req, res) => {
  const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
  const { error } = await sb
    .from("sc_push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", currentUserId(res));
  if (error) throw error;
  res.json({ ok: true });
});

type Sub = { endpoint: string; p256dh: string; auth: string };

// 1台分の送信。届かなかった理由（HTTPの状態）を返す
async function sendTo(sub: Sub, payload: string): Promise<{ ok: true } | { ok: false; status: number | null }> {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 });
    return { ok: true };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? null;
    if (status === 404 || status === 410) {
      // 端末側で購読が無効になったもの。二度と使わないので消す
      await sb.from("sc_push_subscriptions").delete().eq("endpoint", sub.endpoint);
    } else {
      // 届かなかった理由を残す（VAPID鍵の不一致など）
      console.error("Web Push の送信に失敗しました:", status ?? "unknown", (error as Error).message);
    }
    return { ok: false, status };
  }
}

export async function notifyRecipient(args: {
  recipientId: string;
  senderName: string;
  preview: string;
  conversationId: string;
  // この端末では画面が開いているので送らない（端末ごとの通知先）
  skipEndpoints?: Set<string>;
}) {
  if (!pushEnabled) return;
  try {
    const { data: user } = await sb.from("sc_users").select("notify_dm").eq("id", args.recipientId).maybeSingle();
    if (!user?.notify_dm) return;
    const { data: subs } = await sb
      .from("sc_push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", args.recipientId);
    const payload = JSON.stringify({
      title: args.senderName,
      body: args.preview,
      url: `/?dm=${args.conversationId}`,
      tag: `dm-${args.conversationId}`
    });
    await Promise.all(
      ((subs ?? []) as Sub[])
        .filter((sub) => !args.skipEndpoints?.has(sub.endpoint))
        .map((sub) => sendTo(sub, payload))
    );
  } catch (error) {
    console.error("通知の準備に失敗しました:", error);
  }
}

// 設定の「テスト通知」: 画面の状態に関係なく、自分の登録済みの端末すべてに送り、結果を返す
push.post("/push/test", requireAuth, async (_req, res) => {
  if (!pushEnabled) {
    res.status(503).json({ error: "通知は現在利用できません（サーバーに通知の鍵が設定されていません）。" });
    return;
  }
  const { data: subs, error } = await sb
    .from("sc_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", currentUserId(res));
  if (error) throw error;
  if (!subs?.length) {
    res.status(404).json({ error: "この端末は通知に登録されていません。通知をオフにしてから、オンにし直してください。" });
    return;
  }
  const payload = JSON.stringify({
    title: "SoraChat",
    body: "テスト通知です。このメッセージが見えていれば通知は届いています。",
    url: "/",
    tag: "test"
  });
  const results = await Promise.all((subs as Sub[]).map((sub) => sendTo(sub, payload)));
  res.json({
    registered: subs.length,
    delivered: results.filter((r) => r.ok).length,
    failedStatuses: results.flatMap((r) => (r.ok ? [] : [r.status]))
  });
});
