import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { api, post } from "./api";
import type { Message, Reaction } from "./types";

type TokenInfo = { token: string; url: string; anonKey: string; expiresAt: number };

let tokenInfo: TokenInfo | null = null;
let clientPromise: Promise<SupabaseClient> | null = null;
let dataChannel: RealtimeChannel | null = null;

async function fetchToken(): Promise<TokenInfo> {
  const data = await api<{ token: string; url: string; anonKey: string; expiresIn: number }>("/api/realtime/token");
  tokenInfo = { token: data.token, url: data.url, anonKey: data.anonKey, expiresAt: Date.now() + data.expiresIn * 1000 };
  return tokenInfo;
}

export function getClient(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = fetchToken().then(
      (info) =>
        createClient(info.url, info.anonKey, {
          accessToken: async () => {
            if (!tokenInfo || tokenInfo.expiresAt - Date.now() < 60_000) await fetchToken();
            return tokenInfo!.token;
          },
          auth: { persistSession: false, autoRefreshToken: false }
        })
    );
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

// 会話一覧・メンバー・ノートなどの変更通知（Supabase Realtime）
export type DataEvent = { kind: "change" };

const listeners = new Set<(event: DataEvent) => void>();

export function onDataEvent(listener: (event: DataEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const emit = (event: DataEvent) => listeners.forEach((listener) => listener(event));

export async function startDataSync(userId: string) {
  if (dataChannel) return;
  const client = await getClient();
  dataChannel = client
    .channel(`data:${userId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "sc_members" }, () => emit({ kind: "change" }))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sc_conversations" }, () => emit({ kind: "change" }))
    .on("postgres_changes", { event: "*", schema: "public", table: "sc_notes" }, () => emit({ kind: "change" }))
    .subscribe();
}

// ---- WebSocket（メッセージ・リアクション・編集・取り消しのリアルタイム配信）----

export type ChatEvent =
  | { type: "hello" }
  | { type: "message"; message: Message }
  | { type: "message_updated"; conversationId: string; id: string; body: string; editedAt: string }
  | { type: "message_deleted"; conversationId: string; id: string }
  | { type: "reactions"; conversationId: string; messageId: string; reactions: Reaction[] }
  | { type: "read"; conversationId: string; userId: string; readAt: string };

const chatListeners = new Set<(event: ChatEvent) => void>();

export function onChatEvent(listener: (event: ChatEvent) => void) {
  chatListeners.add(listener);
  return () => {
    chatListeners.delete(listener);
  };
}

const emitChat = (event: ChatEvent) => chatListeners.forEach((listener) => listener(event));

let socket: WebSocket | null = null;
let retryTimer = 0;
let retryCount = 0;
let listening = false;
const pending = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void; timer: number }>();

export const isSocketOpen = () => socket?.readyState === WebSocket.OPEN;

function rejectAll(reason: string) {
  for (const [clientId, entry] of pending) {
    window.clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(clientId);
  }
}

// この端末のWeb Pushの宛先。画面を開いている端末には、同じ通知を重ねて送らないようにサーバーへ伝える
let pushEndpoint: string | null = null;
export function setPushEndpoint(endpoint: string | null) {
  pushEndpoint = endpoint;
  sendPresence();
}

// 画面を見ているかをサーバーに知らせる。裏に回しているときは通知を送ってもらうため
function sendPresence() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "presence", visible: !document.hidden, endpoint: pushEndpoint }));
}

function openSocket() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  socket = ws;

  ws.onopen = () => {
    retryCount = 0;
    sendPresence();
    emitChat({ type: "hello" });
    emit({ kind: "change" });
  };

  ws.onmessage = (event) => {
    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type === "ack" || data.type === "error") {
      const entry = pending.get(data.clientId);
      if (!entry) return;
      pending.delete(data.clientId);
      window.clearTimeout(entry.timer);
      if (data.type === "ack") entry.resolve(data.message as Message);
      else entry.reject(new Error(data.error));
      return;
    }
    if (data.type === "list") {
      emit({ kind: "change" });
      return;
    }
    emitChat(data as ChatEvent);
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    rejectAll("接続が切れました。");
    const delay = Math.min(30_000, 500 * 2 ** retryCount);
    retryCount += 1;
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connectRealtime, delay);
  };
}

export function connectRealtime() {
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", () => {
      sendPresence();
      if (!document.hidden) connectRealtime();
    });
    window.addEventListener("online", connectRealtime);
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  window.clearTimeout(retryTimer);
  openSocket();
}

// 送信: 接続中はWebSocketで送り、サーバーの保存完了（ack）を待つ。切断中はHTTPで送る。
export function sendChat(args: {
  clientId: string;
  conversationId: string;
  body: string;
  replyToId?: string | null;
}): Promise<Message> {
  if (!isSocketOpen()) {
    return api<Message>(
      `/api/dm/${args.conversationId}/messages`,
      post({ body: args.body, clientId: args.clientId, replyToId: args.replyToId ?? null })
    );
  }
  return new Promise<Message>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(args.clientId);
      reject(new Error("送信がタイムアウトしました。"));
    }, 10_000);
    pending.set(args.clientId, { resolve, reject, timer });
    socket!.send(JSON.stringify({ type: "send", ...args }));
  });
}
