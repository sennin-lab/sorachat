// グループ電話の通信部分。
// 呼び出しはサーバーが送り（server/calls.ts）、シグナリングはアプリと同じ WebSocket をサーバーが中継し（server/realtime.ts）、
// 音声は参加者どうしの WebRTC（メッシュ）。
// シグナリングの各メッセージは、通話ごとの鍵（HMAC-SHA256）で署名し、改ざんや別の通話への流用を防ぎます。
import { api, post } from "./api";
import { hmacSha256Hex, safeEqual } from "./hmac";
import { connectRealtime, isSocketOpen, onSignal, sendSignal } from "./realtime";

export type CallPeer = { id: string; name: string; hasAvatar: boolean };
export type Invite = { callId: string; conversationId: string; groupName: string; caller: CallPeer; secret: string };

export const MAX_CALL_PEERS = 6; // メッシュ方式のため、通話の人数に上限を設けます
const RING_TIMEOUT_MS = 45_000;
const SIGNAL_MAX_AGE_MS = 5 * 60_000;
const DISCONNECT_GRACE_MS = 6_000;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  const urls = (import.meta.env.VITE_TURN_URLS ?? "").split(",").map((u: string) => u.trim()).filter(Boolean);
  if (urls.length) {
    servers.push({ urls, username: import.meta.env.VITE_TURN_USERNAME ?? "", credential: import.meta.env.VITE_TURN_CREDENTIAL ?? "" });
  }
  return servers;
}

type Peer = {
  info: CallPeer;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
  timer: number;
};

export type CallState =
  | { status: "idle" }
  | { status: "incoming"; invite: Invite }
  | {
      status: "active";
      callId: string;
      conversationId: string;
      groupName: string;
      participants: CallPeer[];
      muted: boolean;
      startedAt: number;
      ringing: boolean;
    };

let me: CallPeer | null = null;
let state: CallState = { status: "idle" };
let stream: MediaStream | null = null;
let callId = "";
let activeConversationId = "";
let signSecret: string | null = null;
// 信号の送受信を始めているか（参加の合図を送ってから true。退出で false に戻す）
let joined = false;
let signalOff: (() => void) | null = null;
let inboxOn = false;
let startedAt = 0;
let ringTimer = 0;
const peers = new Map<string, Peer>();
const listeners = new Set<(s: CallState) => void>();

export function getCallState() {
  return state;
}

export function onCallState(listener: (s: CallState) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setState(next: CallState) {
  state = next;
  listeners.forEach((l) => l(next));
}

function participantsSnapshot(): CallPeer[] {
  const list: CallPeer[] = me ? [me] : [];
  peers.forEach((p) => list.push(p.info));
  return list;
}

function refreshActive(patch: Partial<Extract<CallState, { status: "active" }>> = {}) {
  if (state.status !== "active") return;
  setState({ ...state, participants: participantsSnapshot(), ringing: peers.size === 0, ...patch });
}

// ---- 署名（HMAC-SHA256、通話ごとの鍵）----

// 送るメッセージに、通話ID・送信者・時刻を含めて署名する
function seal(event: string, payload: Record<string, unknown>) {
  if (!signSecret || !joined) return;
  const msg = { callId, from: me?.id, ...payload, ts: Date.now(), event };
  const sig = hmacSha256Hex(signSecret, JSON.stringify(msg));
  if (!sendSignal({ type: "call", callId, event, payload: { ...msg, sig } })) {
    console.error("[call] 信号を送れませんでした:", event);
  }
}

// 受け取ったメッセージの署名・通話ID・時刻を確かめる
function verified(event: string, payload: Record<string, unknown>) {
  const { sig, ...rest } = payload as Record<string, unknown> & { sig?: unknown };
  if (typeof sig !== "string" || !signSecret) return false;
  if (rest.callId !== callId || rest.event !== event) return false;
  if (typeof rest.ts !== "number" || Math.abs(Date.now() - rest.ts) > SIGNAL_MAX_AGE_MS) return false;
  return safeEqual(sig, hmacSha256Hex(signSecret, JSON.stringify(rest)));
}

// ---- 着信の受け取り（ログイン中は常に呼び出しを待つ）----

export async function startCallInbox(_meId: string) {
  if (inboxOn) return;
  inboxOn = true;
  connectRealtime();
  onSignal((signal) => {
    if (signal.type !== "ring") return;
    // 呼び出しはサーバーからだけ届く。形が合わないものは捨てる
    const invite = signal.invite as Invite;
    if (typeof invite?.callId !== "string" || typeof invite?.secret !== "string" || invite.secret.length < 32) return;
    if (state.status !== "idle") return;
    setState({ status: "incoming", invite });
    window.clearTimeout(ringTimer);
    ringTimer = window.setTimeout(() => {
      if (state.status === "incoming" && state.invite.callId === invite.callId) setState({ status: "idle" });
    }, RING_TIMEOUT_MS);
  });
}

// ---- 接続 ----

async function openMic() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch {
    throw new Error("マイクを使えませんでした。ブラウザでマイクの許可を確認してください。");
  }
}

function stopMic() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function armAudioUnlock() {
  document.addEventListener("pointerdown", () => peers.forEach((p) => void p.audio.play().catch(() => {})), { once: true });
}

function createPeer(info: CallPeer): Peer {
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  const audio = new Audio();
  audio.autoplay = true;
  const peer: Peer = { info, pc, audio, remoteSet: false, pendingIce: [], timer: 0 };
  stream?.getTracks().forEach((t) => pc.addTrack(t, stream!));
  pc.onicecandidate = (e) => {
    if (e.candidate) seal("ice", { to: info.id, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    audio.srcObject = e.streams[0];
    audio.play().catch(() => armAudioUnlock());
  };
  pc.onconnectionstatechange = () => {
    window.clearTimeout(peer.timer);
    if (pc.connectionState === "failed") recover(peer);
    if (pc.connectionState === "disconnected") peer.timer = window.setTimeout(() => recover(peer), DISCONNECT_GRACE_MS);
  };
  peers.set(info.id, peer);
  return peer;
}

// 接続が切れた相手との通信をつなぎ直す。ID の小さい側だけが新しい offer を出す（両方から出て衝突するのを防ぐ）
function recover(peer: Peer) {
  if (state.status !== "active" || peers.get(peer.info.id) !== peer) return;
  if (peer.pc.connectionState === "connected") return;
  if (me && me.id < peer.info.id) {
    void initiate(peer.info).then(() => refreshActive());
  } else if (peer.pc.connectionState === "failed") {
    dropPeer(peer.info.id);
  }
}

function dropPeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  window.clearTimeout(peer.timer);
  peer.pc.close();
  peer.audio.srcObject = null;
  peers.delete(id);
  refreshActive();
}

async function flushIce(peer: Peer) {
  for (const c of peer.pendingIce) await peer.pc.addIceCandidate(c).catch(() => {});
  peer.pendingIce = [];
}

async function initiate(info: CallPeer) {
  if (peers.has(info.id)) dropPeer(info.id);
  const peer = createPeer(info);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  seal("offer", { to: info.id, info: me, sdp: offer });
}

// WebSocket がつながるまで待つ（切れていれば再接続を始める）
async function waitForSocket() {
  connectRealtime();
  for (let i = 0; i < 50; i++) {
    if (isSocketOpen()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  throw new Error("通話の接続に失敗しました。通信状態を確認して、もう一度お試しください。");
}

// 通話の信号の受け取りを始め、参加の合図を送る
async function joinChannel() {
  await waitForSocket();
  joined = true;
  // 署名が正しく、同じ通話のものだけ処理する
  const handlers: Record<string, (p: Record<string, any>) => void | Promise<void>> = {
    join: async (p) => {
      if (p.from === me?.id) return;
      const info = p.info as CallPeer;
      if (peers.has(info.id)) dropPeer(info.id);
      if (peers.size + 1 > MAX_CALL_PEERS) return;
      await initiate(info);
      refreshActive();
    },
    offer: async (p) => {
      if (p.to !== me?.id) return;
      const info = p.info as CallPeer;
      if (peers.has(info.id)) dropPeer(info.id);
      if (peers.size + 1 > MAX_CALL_PEERS) return;
      const peer = createPeer(info);
      await peer.pc.setRemoteDescription(p.sdp);
      peer.remoteSet = true;
      await flushIce(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      seal("answer", { to: info.id, sdp: answer });
      refreshActive();
    },
    answer: async (p) => {
      const peer = p.to === me?.id ? peers.get(p.from) : undefined;
      if (!peer) return;
      await peer.pc.setRemoteDescription(p.sdp);
      peer.remoteSet = true;
      await flushIce(peer);
    },
    ice: async (p) => {
      const peer = p.to === me?.id ? peers.get(p.from) : undefined;
      if (!peer) return;
      if (!peer.remoteSet) peer.pendingIce.push(p.candidate);
      else await peer.pc.addIceCandidate(p.candidate).catch(() => {});
    },
    leave: (p) => dropPeer(p.from)
  };
  signalOff?.();
  signalOff = onSignal((signal) => {
    if (signal.type !== "call" || signal.callId !== callId) return;
    const handler = handlers[signal.event];
    if (!handler || !verified(signal.event, signal.payload)) return;
    void handler(signal.payload);
  });
  seal("join", { info: me });
}

// 発信：サーバーに発信を頼むと、サーバーが同じグループの全員に着信を送ります
export async function startGroupCall(args: { conversationId: string; groupName: string; me: CallPeer }) {
  if (state.status !== "idle") return;
  me = args.me;
  await openMic(); // 先にマイクを確認。失敗したらサーバーで発信せず、相手を呼び出さない
  let started: { callId: string; secret: string };
  try {
    started = await api<{ callId: string; secret: string }>("/api/calls", post({ conversationId: args.conversationId }));
  } catch (error) {
    stopMic();
    throw error;
  }
  callId = started.callId;
  activeConversationId = args.conversationId;
  signSecret = started.secret;
  startedAt = Date.now();
  setState({ status: "active", callId, conversationId: args.conversationId, groupName: args.groupName, participants: [me], muted: false, startedAt, ringing: true });
  try {
    await joinChannel();
  } catch (error) {
    await leaveCall(); // 接続に失敗したら通話を片付け、「呼び出し中…」のまま固まらないようにする
    throw error;
  }
}

// 通話に入る（着信への応答・トークの「電話に参加」で共通）。micReady は、マイクを先に確かめ済みのとき
async function enterCall(
  target: { callId: string; conversationId: string; groupName: string; secret: string },
  micReady = false
) {
  if (!me) throw new Error("ユーザー情報がありません");
  callId = target.callId;
  activeConversationId = target.conversationId;
  signSecret = target.secret;
  if (!micReady) await openMic();
  startedAt = Date.now();
  setState({ status: "active", callId, conversationId: target.conversationId, groupName: target.groupName, participants: [me], muted: false, startedAt, ringing: false });
  try {
    await joinChannel();
  } catch (error) {
    await leaveCall(); // 接続に失敗したら片付ける（「呼び出し中…」のまま固まらないように）
    throw error;
  }
  refreshActive();
}

// 着信に応答する。先に参加を記録してから入る（相手の側が、参加した人を必ず見つけられるように）
export async function acceptCall() {
  if (state.status !== "incoming") return;
  const { invite } = state;
  window.clearTimeout(ringTimer);
  await openMic();
  let joinedInfo: { secret: string };
  try {
    joinedInfo = await api<{ secret: string }>(`/api/calls/${invite.callId}/join`, post({ conversationId: invite.conversationId }));
  } catch (error) {
    stopMic();
    throw error;
  }
  await enterCall({ callId: invite.callId, conversationId: invite.conversationId, groupName: invite.groupName, secret: joinedInfo.secret }, true);
}

// トークの「電話に参加」から入る。サーバーが参加を記録し、通話に入るための鍵を返す
export async function joinCallFromChat(args: { callId: string; conversationId: string; groupName: string }) {
  if (state.status !== "idle") return;
  if (!me) throw new Error("ユーザー情報がありません");
  const joinedInfo = await api<{ secret: string }>(`/api/calls/${args.callId}/join`, post({ conversationId: args.conversationId }));
  try {
    await enterCall({ ...args, secret: joinedInfo.secret });
  } catch (error) {
    void api(`/api/calls/${args.callId}/leave`, post({ conversationId: args.conversationId })).catch(() => {});
    throw error;
  }
}

export function declineCall() {
  if (state.status !== "incoming") return;
  window.clearTimeout(ringTimer);
  setState({ status: "idle" });
}

export function setIdentity(identity: CallPeer) {
  me = identity;
}

export function toggleMute() {
  if (state.status !== "active") return;
  const next = !state.muted;
  stream?.getAudioTracks().forEach((t) => (t.enabled = !next));
  setState({ ...state, muted: next });
}

export async function leaveCall() {
  if (state.status === "incoming") return declineCall();
  if (state.status !== "active") return;
  seal("leave", {}); // 退出の合図を送ってから、信号の受け取りを止める
  joined = false;
  signalOff?.();
  signalOff = null;
  void api(`/api/calls/${callId}/leave`, post({ conversationId: activeConversationId })).catch(() => {});
  peers.forEach((p) => {
    window.clearTimeout(p.timer);
    p.pc.close();
    p.audio.srcObject = null;
  });
  peers.clear();
  stopMic();
  signSecret = null;
  callId = "";
  setState({ status: "idle" });
}
