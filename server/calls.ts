// グループ通話の発信・参加・退出。呼び出しはサーバーだけが送り、参加・退出・終了は通話の中のお知らせとしてトークに残します。
// 身元はログインのセッションから決め、表示名などはDBから取るため、クライアントの申告は信用しません。
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { currentUserId, randomToken, requireAuth } from "./auth.js";
import { config } from "./config.js";
import { UUID, displayNameOf, memberIds, membership, postNotice } from "./messages.js";
import { sb } from "./supabase.js";

export const calls = Router();

const startSchema = z.object({ conversationId: z.string().regex(UUID) });
const eventSchema = z.object({ conversationId: z.string().regex(UUID) });
const callIdSchema = z.string().regex(UUID);

// 進行中の通話（メモリ上。サーバーが再起動すると消え、以後のお知らせは出ません）
type CallRecord = { conversationId: string; startedAt: number; participants: Set<string> };
const active = new Map<string, CallRecord>();
const MAX_CALL_AGE_MS = 12 * 60 * 60_000;

// 連打の防止（1人あたり、時間枠の中で max 回まで）
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

function pruneCalls() {
  const now = Date.now();
  for (const [id, record] of active) if (now - record.startedAt > MAX_CALL_AGE_MS) active.delete(id);
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// Supabase Realtime の REST 経由で、呼び出しを相手ごとの private チャンネルに送る（サーバーのサービスキーを使用）
async function sendRings(userIds: string[], payload: unknown) {
  for (let i = 0; i < userIds.length; i += 100) {
    const messages = userIds.slice(i, i + 100).map((id) => ({ topic: `callin:${id}`, event: "ring", payload, private: true }));
    const response = await fetch(`${config.supabaseUrl}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseServiceKey,
        Authorization: `Bearer ${config.supabaseServiceKey}`
      },
      body: JSON.stringify({ messages })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Realtime broadcast failed: ${response.status} ${detail}`);
    }
  }
}

calls.post("/calls", requireAuth, async (req, res) => {
  try {
    const userId = currentUserId(res);
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "グループが正しくありません。" });
      return;
    }
    const { conversationId } = parsed.data;
    if (!allow(`start:${userId}`, 8, 10 * 60_000)) {
      res.status(429).json({ error: "通話の発信が多すぎます。少し待ってからもう一度お試しください。" });
      return;
    }
    if (!(await membership(conversationId, userId))) {
      res.status(403).json({ error: "このトークには参加していません。" });
      return;
    }
    const { data: conversation, error: convError } = await sb
      .from("sc_conversations")
      .select("title, is_group")
      .eq("id", conversationId)
      .maybeSingle();
    if (convError) throw convError;
    if (!conversation?.is_group) {
      res.status(400).json({ error: "グループでのみ通話できます。" });
      return;
    }
    const { data: caller, error: callerError } = await sb
      .from("sc_users")
      .select("id, display_name, avatar_path")
      .eq("id", userId)
      .maybeSingle();
    if (callerError) throw callerError;

    const callId = randomUUID();
    const secret = randomToken(32); // この通話の署名鍵（参加者だけに届く）
    pruneCalls();
    active.set(callId, { conversationId, startedAt: Date.now(), participants: new Set([userId]) });
    const callerInfo = { id: userId, name: caller?.display_name ?? "", hasAvatar: Boolean(caller?.avatar_path) };
    const others = (await memberIds(conversationId)).filter((id) => id !== userId);
    // グループ名は sc_conversations.title に入っている（名前がないグループは「グループ」と表示）
    const groupName = conversation.title || "グループ";
    await sendRings(others, { callId, conversationId, groupName, caller: callerInfo, secret });
    await postNotice(conversationId, userId, "通話が開始しています");

    res.json({ callId, secret });
  } catch (error) {
    console.error("[calls] 発信に失敗:", error);
    res.status(500).json({ error: "通話を始められませんでした。" });
  }
});

// 通話に参加したとき（発信者は発信時に参加済み）
calls.post("/calls/:callId/join", requireAuth, async (req, res) => {
  try {
    const userId = currentUserId(res);
    const callId = callIdSchema.safeParse(req.params.callId);
    const parsed = eventSchema.safeParse(req.body);
    if (!callId.success || !parsed.success) {
      res.status(400).json({ error: "通話が正しくありません。" });
      return;
    }
    if (!allow(`event:${userId}`, 30, 10 * 60_000)) {
      res.status(429).json({ error: "操作が多すぎます。" });
      return;
    }
    const record = active.get(callId.data);
    if (!record || record.conversationId !== parsed.data.conversationId) {
      res.status(404).json({ error: "通話が見つかりません。" });
      return;
    }
    if (!(await membership(record.conversationId, userId))) {
      res.status(403).json({ error: "このトークには参加していません。" });
      return;
    }
    if (!record.participants.has(userId)) {
      record.participants.add(userId);
      await postNotice(record.conversationId, userId, `${await displayNameOf(userId)}さんが参加しました`);
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "通話の参加を記録できませんでした。" });
  }
});

// 通話から退出したとき。最後の1人が抜けると、通話時間つきで終了をお知らせします
calls.post("/calls/:callId/leave", requireAuth, async (req, res) => {
  try {
    const userId = currentUserId(res);
    const callId = callIdSchema.safeParse(req.params.callId);
    const parsed = eventSchema.safeParse(req.body);
    if (!callId.success || !parsed.success) {
      res.status(400).json({ error: "通話が正しくありません。" });
      return;
    }
    if (!allow(`event:${userId}`, 30, 10 * 60_000)) {
      res.status(429).json({ error: "操作が多すぎます。" });
      return;
    }
    const record = active.get(callId.data);
    // 通話が見つからない・参加していない場合は何もしない（二重に呼ばれても安全）
    if (!record || record.conversationId !== parsed.data.conversationId || !record.participants.has(userId)) {
      res.json({ ok: true });
      return;
    }
    record.participants.delete(userId);
    await postNotice(record.conversationId, userId, `${await displayNameOf(userId)}さんが退出しました`);
    if (record.participants.size === 0) {
      active.delete(callId.data);
      await postNotice(record.conversationId, userId, `通話が終了しました（通話時間 ${formatDuration(Date.now() - record.startedAt)}）`);
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "通話の退出を記録できませんでした。" });
  }
});
