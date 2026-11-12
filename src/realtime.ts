import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { api, post } from "./api";
import type { GameView, Message, PollView, Reaction } from "./types";

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
  | { type: "message_removed"; conversationId: string; id: string }
  | { type: "reactions"; conversationId: string; messageId: string; reactions: Reaction[] }
  | { type: "poll"; conversationId: string; messageId: string; poll: PollView }
  | { type: "game"; conversationId: string; messageId: string; game: GameView }
  | { type: "read"; conversationId: string; userId: string; readAt: string }
  | { type: "typing"; conversationId: string; userId: string };

const chatListeners = new Set<(event: ChatEvent) => void>();

export function onChatEvent(listener: (event: ChatEvent) => void) {
  chatListeners.add(listener);
  return () => {
    chatListeners.delete(listener);
  };
}

const emitChat = (event: ChatEvent) => chatListeners.forEach((listener) => listener(event));

let socket: WebSocket | null = null;
// 往復時間（ミリ秒）。自分で測った値（EMA）と、サーバーが測った値（ping に入って届く）
let rttEma: number | null = null;
let serverRtt: number | null = null;
let clientPingTimer = 0;
// 今の往復時間の目安。ミニゲームの画面の表示に使う（測れていなければ 0）
export function getRttMs(): number {
  return Math.round(rttEma ?? serverRtt ?? 0);
}
function addRttSample(sample: number) {
  if (!Number.isFinite(sample) || sample < 0 || sample > 10_000) return;
  rttEma = rttEma === null ? sample : rttEma * 0.7 + sample * 0.3;
}
let retryTimer = 0;
let retryCount = 0;
let listening = false;
const pending = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void; timer: number }>();

export const isSocketOpen = () => socket?.readyState === WebSocket.OPEN;

// ---- 通話の信号（呼び出し・参加・SDP・ICE・退出）。アプリと同じ WebSocket で送受信する ----
// Supabase Realtime の別の接続は使わない（一部の端末で接続できず、通話が始まらなかったため）
export type SignalEvent =
  | { type: "ring"; invite: unknown }
  | { type: "call"; callId: string; event: string; payload: Record<string, unknown> };

const signalListeners = new Set<(signal: SignalEvent) => void>();

export function onSignal(listener: (signal: SignalEvent) => void) {
  signalListeners.add(listener);
  return () => {
    signalListeners.delete(listener);
  };
}

// 信号を送る。接続中でなければ false（呼び出し側で案内を出す）
export function sendSignal(message: Record<string, unknown>): boolean {
  if (!isSocketOpen()) return false;
  socket!.send(JSON.stringify(message));
  return true;
}

function rejectAll(reason: string) {
  for (const [clientId, entry] of pending) {
    window.clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(clientId);
  }
  for (const [reqId, entry] of pendingGame) {
    window.clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pendingGame.delete(reqId);
  }
}

// ミニゲームの操作の返事（ack / error）を待つ一覧
const pendingGame = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: number }>();
let gameSeq = 0;

// ミニゲームの操作を WebSocket で送る。サーバーが処理したら resolve、できなければ reject（理由つき）
export function sendGameAction(messageId: string, action: Record<string, unknown>): Promise<void> {
  if (!isSocketOpen()) return Promise.reject(new Error("接続されていません。"));
  gameSeq += 1;
  const reqId = `${Date.now().toString(36)}-${gameSeq}`;
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingGame.delete(reqId);
      reject(new Error("操作がタイムアウトしました。"));
    }, 8_000);
    pendingGame.set(reqId, { resolve, reject, timer });
    socket!.send(JSON.stringify({ type: "game-action", reqId, messageId, action }));
  });
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
    // 自分からも ping を送り、返事（pong）で往復時間を測る（サーバーが返さない場合は、サーバーの値を使う）
    window.clearInterval(clientPingTimer);
    clientPingTimer = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
    }, 3_000);
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
    // サーバーの ping には必ず pong で返す（サーバーはこれで往復時間を測る）
    if (data.type === "ping") {
      if (typeof data.rtt === "number") serverRtt = data.rtt;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong", t: data.t }));
      return;
    }
    if (data.type === "pong") {
      if (typeof data.t === "number") addRttSample(Date.now() - data.t);
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
    if (data.type === "game-ack" || data.type === "game-error") {
      const entry = pendingGame.get(data.reqId);
      if (!entry) return;
      pendingGame.delete(data.reqId);
      window.clearTimeout(entry.timer);
      if (data.type === "game-ack") entry.resolve();
      else entry.reject(new Error(data.error));
      return;
    }
    if (data.type === "list") {
      emit({ kind: "change" });
      return;
    }
    if (data.type === "ring" || data.type === "call") {
      signalListeners.forEach((listener) => listener(data as SignalEvent));
      return;
    }
    emitChat(data as ChatEvent);
  };

  ws.onclose = (event) => {
    window.clearInterval(clientPingTimer);
    if (socket === ws) socket = null;
    rejectAll("接続が切れました。");
    // 利用停止になったときは再接続せず、アカウントの状態を確認し直す（利用停止の画面に切り替わる）
    if (event.code === 4003) {
      window.dispatchEvent(new Event("account-check"));
      return;
    }
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

// 入力中の知らせを送る（接続中のときだけ。切れていれば何もしない）
export function sendTyping(conversationId: string): boolean {
  if (!isSocketOpen()) return false;
  socket!.send(JSON.stringify({ type: "typing", conversationId }));
  return true;
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
