import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { banOfUser, SESSION_COOKIE, sha256 } from "./auth.js";
import { config } from "./config.js";
import { getMaintenanceSettings } from "./maintenance.js";
import { addSocket, removeSocket, sendToUser, setViewing } from "./hub.js";
import { findCall } from "./callRegistry.js";
import { BlockedError, UUID, blockersOf, insertMessage, memberIds, membership, replyTargetOk, toMessage } from "./messages.js";
import { senninaiAfterMessage, senninaiPrecheck } from "./senninai.js";
import { sb } from "./supabase.js";
import { isIpBanned, upgradeIp } from "./ipBans.js";
import { gameAction, gameActionInput } from "./games.js";
import { GameError } from "./gameLogic.js";

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

const sendSchema = z.object({
  type: z.literal("send"),
  clientId: z.string().min(1).max(64),
  conversationId: z.string().regex(UUID),
  body: z.string().trim().min(1).max(1000),
  replyToId: z.string().regex(UUID).nullish()
});

// グループ通話の信号（参加・SDP・ICE・退出）。中身は通話ごとの鍵で署名されていて、サーバーは中身を読まずに中継するだけ。
// 参加している人からの信号だけを、ほかの参加者へ送る（参加していない人には届かない）
const callSignalSchema = z.object({
  type: z.literal("call"),
  callId: z.string().regex(UUID),
  event: z.enum(["join", "offer", "answer", "ice", "leave"]),
  payload: z.record(z.string(), z.unknown())
});

// 画面を見ているかどうかの通知（アプリを裏に回したら false になる）
const presenceSchema = z.object({ type: z.literal("presence"), visible: z.boolean(), endpoint: z.string().max(2048).nullish() });

// 入力中の知らせ（会話ID だけを受け取り、中身は保存しない）
// ミニゲームの操作（参加・開始・プレイなど）。サーバーのメモリで即座に処理し、会員へすぐ送る
const gameSocketSchema = z.object({
  type: z.literal("game-action"),
  reqId: z.string().min(1).max(64),
  messageId: z.string().regex(UUID),
  action: gameActionInput
});
// 1つの接続から、ゲームの操作を連打しすぎないように（1秒あたりの上限）
const GAME_ACTIONS_PER_SECOND = 20;
const gameActionCount = new WeakMap<WebSocket, { second: number; count: number }>();

const typingSchema = z.object({ type: z.literal("typing"), conversationId: z.string().regex(UUID) });
const TYPING_MIN_GAP_MS = 1500;
const lastTypingAt = new WeakMap<WebSocket, number>();

async function userFromRequest(req: IncomingMessage): Promise<string | null> {
  const match = req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const { data, error } = await sb
    .from("sc_sessions")
    .select("user_id, expires_at")
    .eq("token_hash", sha256(match[1]))
    .maybeSingle();
  if (error || !data || new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.user_id as string;
}

function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachRealtime(server: Server) {
  server.on("upgrade", (req, socket: Duplex, head) => {
    // メンテナンス中は WebSocket でも送受信させない
    if (getMaintenanceSettings().enabled) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!sameOrigin(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    // IP BAN されたネットワークからは、WebSocket（トーク・ミニゲーム・通話）も使わせない
    if (isIpBanned(upgradeIp(req))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    userFromRequest(req)
      .then(async (userId) => {
        if (!userId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        if (await banOfUser(userId)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => connect(userId, ws));
      })
      .catch(() => socket.destroy());
  });
}

function reply(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// 往復時間（ミリ秒）の測定。アプリの ping/pong で、接続ごとに滑らかな値を持つ
const rttSamples = new WeakMap<WebSocket, number>();
export function rttOf(ws: WebSocket): number {
  return Math.round(rttSamples.get(ws) ?? 0);
}

function connect(userId: string, ws: WebSocket) {
  addSocket(userId, ws);
  // 2秒ごとに ping を送り、返事（pong）で往復時間を測る。遠い人ほど、反応の補正を大きくするため
  const rttTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", t: Date.now(), rtt: rttOf(ws) }));
  }, 2_000);
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 25_000);
  ws.on("message", (raw: RawData) => void handle(userId, ws, raw));
  ws.on("close", () => {
    clearInterval(timer);
    clearInterval(rttTimer);
    removeSocket(userId, ws);
  });
  ws.on("error", () => ws.terminate());
}

async function handle(userId: string, ws: WebSocket, raw: RawData) {
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (data?.type === "ping") {
    // 画面からの ping（往復時間を測るため）。同じ t をそのまま返す
    reply(ws, { type: "pong", t: data.t });
    return;
  }
  if (data?.type === "pong") {
    // 自分が送った ping の返事。往復時間を滑らかに更新する（異常な値は捨てる）
    const sent = typeof data.t === "number" ? data.t : NaN;
    const sample = Date.now() - sent;
    if (Number.isFinite(sample) && sample >= 0 && sample < 10_000) {
      const previous = rttSamples.get(ws);
      rttSamples.set(ws, previous === undefined ? sample : previous * 0.7 + sample * 0.3);
    }
    return;
  }
  if (data?.type === "presence") {
    const presence = presenceSchema.safeParse(data);
    if (presence.success) setViewing(ws, presence.data.visible, presence.data.endpoint ?? null);
    return;
  }
  if (data?.type === "typing") {
    const typing = typingSchema.safeParse(data);
    if (!typing.success) return;
    // 短い間隔の連続は捨てる（問い合わせを増やさないため）
    const now = Date.now();
    if (now - (lastTypingAt.get(ws) ?? 0) < TYPING_MIN_GAP_MS) return;
    lastTypingAt.set(ws, now);
    const conversationId = typing.data.conversationId;
    try {
      const [member, members, blockers] = await Promise.all([
        membership(conversationId, userId),
        memberIds(conversationId),
        blockersOf(userId)
      ]);
      if (!member) return;
      // 送った本人と、この人をブロックしている人以外へ（開いている画面にだけ届く）
      for (const uid of members) {
        if (uid !== userId && !blockers.has(uid)) sendToUser(uid, { type: "typing", conversationId, userId });
      }
    } catch {
      // 入力中の表示は補助なので、失敗しても何もしない
    }
    return;
  }
  if (data?.type === "call") {
    const signal = callSignalSchema.safeParse(data);
    if (!signal.success) return;
    const record = findCall(signal.data.callId);
    if (!record || !record.participants.has(userId)) return;
    for (const uid of record.participants) {
      if (uid !== userId) sendToUser(uid, { type: "call", callId: signal.data.callId, event: signal.data.event, payload: signal.data.payload });
    }
    return;
  }
  if (data?.type === "game-action") {
    const reqId = typeof data.reqId === "string" ? data.reqId.slice(0, 64) : "";
    const messageId = typeof data.messageId === "string" ? data.messageId : "";
    const parsed = gameSocketSchema.safeParse(data);
    if (!parsed.success) {
      reply(ws, { type: "game-error", reqId, messageId, error: "その操作はできません。" });
      return;
    }
    const second = Math.floor(Date.now() / 1000);
    const counter = gameActionCount.get(ws);
    if (!counter || counter.second !== second) gameActionCount.set(ws, { second, count: 1 });
    else if (++counter.count > GAME_ACTIONS_PER_SECOND) {
      reply(ws, { type: "game-error", reqId, messageId, error: "操作が多すぎます。少し待ってください。" });
      return;
    }
    try {
      await gameAction(parsed.data.messageId, userId, parsed.data.action, rttOf(ws));
      reply(ws, { type: "game-ack", reqId, messageId: parsed.data.messageId });
    } catch (error) {
      if (!(error instanceof GameError)) console.error("[ws] ミニゲームの操作に失敗しました", error);
      reply(ws, {
        type: "game-error",
        reqId,
        messageId: parsed.data.messageId,
        error: error instanceof GameError ? error.message : "操作できませんでした。"
      });
    }
    return;
  }
  if (data?.type !== "send") return;
  const parsed = sendSchema.safeParse(data);
  if (!parsed.success) {
    reply(ws, { type: "error", clientId: typeof data.clientId === "string" ? data.clientId : null, error: "メッセージは1〜1000文字で入力してください。" });
    return;
  }
  const { clientId, conversationId, body, replyToId } = parsed.data;
  try {
    // 会員確認と返信先の確認は互いに依存しないので、並べて問い合わせる（待ち時間を減らす）
    const [isMember, replyOk] = await Promise.all([
      membership(conversationId, userId),
      replyTargetOk(conversationId, replyToId)
    ]);
    if (!isMember) {
      reply(ws, { type: "error", clientId, error: "会話が見つかりません。" });
      return;
    }
    if (!replyOk) {
      reply(ws, { type: "error", clientId, error: "返信先のメッセージが見つかりません。" });
      return;
    }
    const problem = await senninaiPrecheck(conversationId, userId, body);
    if (problem) {
      reply(ws, { type: "error", clientId, error: problem });
      return;
    }
    const row = await insertMessage(conversationId, userId, { kind: "text", body }, body, {
      clientId,
      replyToId: replyToId ?? null
    });
    reply(ws, { type: "ack", clientId, message: toMessage(row, [], clientId) });
    void senninaiAfterMessage(conversationId, userId, body, row);
  } catch (error) {
    reply(ws, { type: "error", clientId, error: error instanceof BlockedError ? error.message : "送信できませんでした。" });
  }
}
