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

export async function notifyRecipient(args: {
  recipientId: string;
  senderName: string;
  preview: string;
  conversationId: string;
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
      (subs ?? []).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 3600 }
          );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await sb.from("sc_push_subscriptions").delete().eq("endpoint", sub.endpoint);
          }
        }
      })
    );
  } catch {
    return;
  }
}
