// グループ電話の通信部分。
// 呼び出しはサーバーが送り（server/calls.ts）、シグナリングは Supabase Realtime、音声は参加者どうしの WebRTC（メッシュ）。
// シグナリングの各メッセージは、通話ごとの鍵（HMAC-SHA256）で署名し、改ざんや別の通話への流用を防ぎます。
import type { RealtimeChannel } from "@supabase/supabase-js";
import { api, post } from "./api";
import { getClient } from "./realtime";

export type CallPeer = { id: string; name: string; hasAvatar: boolean };
export type Invite = { callId: string; conversationId: string; groupName: string; caller: CallPeer; secret: string };

export const MAX_CALL_PEERS = 6; // メッシュ方式のため、通話の人数に上限を設けます
const RING_TIMEOUT_MS = 45_000;
const SIGNAL_MAX_AGE_MS = 5 * 60_000;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const enc = new TextEncoder();

type Peer = {
  info: CallPeer;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
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
let inbox: RealtimeChannel | null = null;
let channel: RealtimeChannel | null = null;
let stream: MediaStream | null = null;
let callId = "";
let activeConversationId = "";
let signKey: CryptoKey | null = null;
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

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? []);

async function importSignKey(secret: string) {
  signKey = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// 送るメッセージに、通話ID・送信者・時刻を含めて署名する
function seal(event: string, payload: Record<string, unknown>) {
  if (!signKey || !channel) return;
  const msg = { callId, from: me?.id, ...payload, ts: Date.now(), event };
  return crypto.subtle.sign("HMAC", signKey, enc.encode(JSON.stringify(msg))).then((sig) => {
    channel?.send({ type: "broadcast", event, payload: { ...msg, sig: toHex(sig) } });
  });
}

// 受け取ったメッセージの署名・通話ID・時刻を確かめる
async function verified(event: string, payload: Record<string, unknown>) {
  const { sig, ...rest } = payload as Record<string, unknown> & { sig?: unknown };
  if (typeof sig !== "string" || !signKey) return false;
  if (rest.callId !== callId || rest.event !== event) return false;
  if (typeof rest.ts !== "number" || Math.abs(Date.now() - rest.ts) > SIGNAL_MAX_AGE_MS) return false;
  return crypto.subtle.verify("HMAC", signKey, fromHex(sig), enc.encode(JSON.stringify(rest)));
}

// ---- 着信の受け取り（ログイン中は常に自分の呼び出し用チャンネルを購読）----

export async function startCallInbox(meId: string) {
  if (inbox) return;
  const client = await getClient();
  inbox = client
    .channel(`callin:${meId}`, { config: { private: true } })
    .on("broadcast", { event: "ring" }, ({ payload }) => {
      // 呼び出しはサーバーからだけ届く。形が合わないものは捨てる
      const invite = payload as Invite;
      if (typeof invite?.callId !== "string" || typeof invite?.secret !== "string" || invite.secret.length < 32) return;
      if (state.status !== "idle") return;
      setState({ status: "incoming", invite });
      window.clearTimeout(ringTimer);
      ringTimer = window.setTimeout(() => {
        if (state.status === "incoming" && state.invite.callId === invite.callId) setState({ status: "idle" });
      }, RING_TIMEOUT_MS);
    });
  inbox.subscribe();
}

// ---- 接続 ----

async function openMic() {
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
}

function createPeer(info: CallPeer): Peer {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const audio = new Audio();
  audio.autoplay = true;
  const peer: Peer = { info, pc, audio, remoteSet: false, pendingIce: [] };
  stream?.getTracks().forEach((t) => pc.addTrack(t, stream!));
  pc.onicecandidate = (e) => {
    if (e.candidate) void seal("ice", { to: info.id, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") dropPeer(info.id);
  };
  peers.set(info.id, peer);
  return peer;
}

function dropPeer(id: string) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.audio.srcObject = null;
  peers.delete(id);
  refreshActive();
}

async function flushIce(peer: Peer) {
  for (const c of peer.pendingIce) await peer.pc.addIceCandidate(c).catch(() => {});
  peer.pendingIce = [];
}

async function joinChannel(conversationId: string) {
  const client = await getClient();
  const ch = client.channel(`call:${conversationId}`, { config: { private: true, broadcast: { self: false } } });
  channel = ch;
  // 署名が正しいものだけ処理する
  const on = (event: string, fn: (p: Record<string, any>) => void | Promise<void>) =>
    ch.on("broadcast", { event }, async ({ payload }) => {
      if (await verified(event, payload)) await fn(payload);
    });

  on("join", async (p) => {
    if (p.from === me?.id) return;
    const info = p.info as CallPeer;
    if (peers.has(info.id)) dropPeer(info.id);
    if (peers.size + 1 > MAX_CALL_PEERS) return;
    const peer = createPeer(info);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    await seal("offer", { to: info.id, info: me, sdp: offer });
    refreshActive();
  });
  on("offer", async (p) => {
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
    await seal("answer", { to: info.id, sdp: answer });
    refreshActive();
  });
  on("answer", async (p) => {
    const peer = p.to === me?.id ? peers.get(p.from) : undefined;
    if (!peer) return;
    await peer.pc.setRemoteDescription(p.sdp);
    peer.remoteSet = true;
    await flushIce(peer);
  });
  on("ice", async (p) => {
    const peer = p.to === me?.id ? peers.get(p.from) : undefined;
    if (!peer) return;
    if (!peer.remoteSet) peer.pendingIce.push(p.candidate);
    else await peer.pc.addIceCandidate(p.candidate).catch(() => {});
  });
  on("leave", (p) => dropPeer(p.from));

  await new Promise<void>((resolve, reject) => {
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error("通話の接続に失敗しました"));
    });
  });
  await seal("join", { info: me });
}

// 発信：サーバーに発信を頼むと、サーバーが同じグループの全員に着信を送ります
export async function startGroupCall(args: { conversationId: string; groupName: string; me: CallPeer }) {
  if (state.status !== "idle") return;
  me = args.me;
  const started = await api<{ callId: string; secret: string }>("/api/calls", post({ conversationId: args.conversationId }));
  callId = started.callId;
  activeConversationId = args.conversationId;
  await importSignKey(started.secret);
  startedAt = Date.now();
  await openMic();
  setState({ status: "active", callId, conversationId: args.conversationId, groupName: args.groupName, participants: [me], muted: false, startedAt, ringing: true });
  await joinChannel(args.conversationId);
}

// 着信に応答する
export async function acceptCall() {
  if (state.status !== "incoming") return;
  const { invite } = state;
  if (!me) throw new Error("ユーザー情報がありません");
  window.clearTimeout(ringTimer);
  callId = invite.callId;
  activeConversationId = invite.conversationId;
  await importSignKey(invite.secret);
  startedAt = Date.now();
  await openMic();
  setState({ status: "active", callId, conversationId: invite.conversationId, groupName: invite.groupName, participants: [me], muted: false, startedAt, ringing: false });
  await joinChannel(invite.conversationId);
  void api(`/api/calls/${callId}/join`, post({ conversationId: invite.conversationId })).catch(() => {});
  refreshActive();
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
  await seal("leave", {}); // 退出の合図を送り終えてから、チャンネルを閉じる
  void api(`/api/calls/${callId}/leave`, post({ conversationId: activeConversationId })).catch(() => {});
  const client = await getClient().catch(() => null);
  if (channel && client) client.removeChannel(channel);
  channel = null;
  peers.forEach((p) => {
    p.pc.close();
    p.audio.srcObject = null;
  });
  peers.clear();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  signKey = null;
  callId = "";
  setState({ status: "idle" });
}
