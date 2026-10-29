import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { SESSION_COOKIE, sha256 } from "./auth.js";
import { addSocket, removeSocket, setViewing } from "./hub.js";
import { UUID, insertMessage, membership, replyTargetOk, toMessage } from "./messages.js";
import { sb } from "./supabase.js";

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

const sendSchema = z.object({
  type: z.literal("send"),
  clientId: z.string().min(1).max(64),
  conversationId: z.string().regex(UUID),
  body: z.string().trim().min(1).max(1000),
  replyToId: z.string().regex(UUID).nullish()
});

// 画面を見ているかどうかの通知（アプリを裏に回したら false になる）
const presenceSchema = z.object({ type: z.literal("presence"), visible: z.boolean() });

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
    userFromRequest(req)
      .then((userId) => {
        if (!userId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
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

function connect(userId: string, ws: WebSocket) {
  addSocket(userId, ws);
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
  if (data?.type === "presence") {
    const presence = presenceSchema.safeParse(data);
    if (presence.success) setViewing(ws, presence.data.visible);
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
    if (!(await membership(conversationId, userId))) {
      reply(ws, { type: "error", clientId, error: "会話が見つかりません。" });
      return;
    }
    if (!(await replyTargetOk(conversationId, replyToId))) {
      reply(ws, { type: "error", clientId, error: "返信先のメッセージが見つかりません。" });
      return;
    }
    const row = await insertMessage(conversationId, userId, { kind: "text", body }, body, {
      clientId,
      replyToId: replyToId ?? null
    });
    reply(ws, { type: "ack", clientId, message: toMessage(row, [], clientId) });
  } catch {
    reply(ws, { type: "error", clientId, error: "送信できませんでした。" });
  }
}
