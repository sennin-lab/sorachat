// グループ電話の通信部分。
// シグナリング（呼び出し・SDP・ICE）は Supabase Realtime の broadcast を使い、Render のサーバーは経由しません。
// 音声は参加者どうしの WebRTC（メッシュ）で直接やり取りします。
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getClient } from "./realtime";

export type CallPeer = { id: string; name: string; hasAvatar: boolean };
export type Invite = { callId: string; conversationId: string; groupName: string; caller: CallPeer };

export const MAX_CALL_PEERS = 6; // メッシュ方式のため、通話の人数に上限を設けます
const RING_TIMEOUT_MS = 45_000;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

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
let groupName = "";
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

// ---- 着信の受け取り（ログイン中は常に自分の呼び出し用チャンネルを購読）----

export async function startCallInbox(meId: string) {
  if (inbox) return;
  const client = await getClient();
  inbox = client
    .channel(`callin:${meId}`, { config: { private: true } })
    .on("broadcast", { event: "ring" }, ({ payload }) => {
      const invite = payload as Invite;
      // 通話中・すでに着信中のときは出さない（そのまま無視）
      if (state.status !== "idle") return;
      setState({ status: "incoming", invite });
      window.clearTimeout(ringTimer);
      ringTimer = window.setTimeout(() => {
        if (state.status === "incoming" && state.invite.callId === invite.callId) setState({ status: "idle" });
      }, RING_TIMEOUT_MS);
    });
  inbox.subscribe();
}

// ---- 発信・応答 ----

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
    if (e.candidate) send("ice", { to: info.id, candidate: e.candidate.toJSON() });
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

function send(event: string, payload: Record<string, unknown>) {
  channel?.send({ type: "broadcast", event, payload: { callId, from: me?.id, ...payload } });
}

// 参加の合図。既存の参加者は、新しく来た人に向けて接続を申し出ます
async function joinChannel(conversationId: string) {
  const client = await getClient();
  const ch = client.channel(`call:${conversationId}`, { config: { private: true, broadcast: { self: false } } });
  channel = ch;
  ch.on("broadcast", { event: "join" }, async ({ payload }) => {
    if (payload.callId !== callId || payload.from === me?.id) return;
    const info = payload.info as CallPeer;
    if (peers.has(info.id)) dropPeer(info.id); // 再入室のときは作り直す
    if (peers.size + 1 > MAX_CALL_PEERS) return;
    const peer = createPeer(info);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    send("offer", { to: info.id, info: me, sdp: offer });
    refreshActive();
  });
  ch.on("broadcast", { event: "offer" }, async ({ payload }) => {
    if (payload.callId !== callId || payload.to !== me?.id) return;
    const info = payload.info as CallPeer;
    if (peers.has(info.id)) dropPeer(info.id);
    const peer = createPeer(info);
    await peer.pc.setRemoteDescription(payload.sdp);
    peer.remoteSet = true;
    await flushIce(peer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    send("answer", { to: info.id, sdp: answer });
    refreshActive();
  });
  ch.on("broadcast", { event: "answer" }, async ({ payload }) => {
    if (payload.callId !== callId || payload.to !== me?.id) return;
    const peer = peers.get(payload.from);
    if (!peer) return;
    await peer.pc.setRemoteDescription(payload.sdp);
    peer.remoteSet = true;
    await flushIce(peer);
  });
  ch.on("broadcast", { event: "ice" }, async ({ payload }) => {
    if (payload.callId !== callId || payload.to !== me?.id) return;
    const peer = peers.get(payload.from);
    if (!peer) return;
    if (!peer.remoteSet) peer.pendingIce.push(payload.candidate);
    else await peer.pc.addIceCandidate(payload.candidate).catch(() => {});
  });
  ch.on("broadcast", { event: "leave" }, ({ payload }) => {
    if (payload.callId === callId) dropPeer(payload.from);
  });
  await new Promise<void>((resolve, reject) => {
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error("通話の接続に失敗しました"));
    });
  });
  ch.send({ type: "broadcast", event: "join", payload: { callId, from: me?.id, info: me } });
}

async function flushIce(peer: Peer) {
  for (const c of peer.pendingIce) await peer.pc.addIceCandidate(c).catch(() => {});
  peer.pendingIce = [];
}

// 呼び出し：同じグループの全員に「着信」を送り、通話のチャンネルに入ります
export async function startGroupCall(args: { conversationId: string; groupName: string; memberIds: string[]; me: CallPeer }) {
  if (state.status !== "idle") return;
  me = args.me;
  callId = crypto.randomUUID();
  groupName = args.groupName;
  startedAt = Date.now();
  await openMic();
  setState({ status: "active", callId, conversationId: args.conversationId, groupName, participants: [me], muted: false, startedAt, ringing: true });
  await joinChannel(args.conversationId);
  const client = await getClient();
  const invite: Invite = { callId, conversationId: args.conversationId, groupName, caller: me };
  for (const id of args.memberIds) {
    if (id === me.id) continue;
    const ring = client.channel(`callin:${id}`, { config: { private: true } });
    ring.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        ring.send({ type: "broadcast", event: "ring", payload: invite }).finally(() => {
          window.setTimeout(() => client.removeChannel(ring), 1500);
        });
      }
    });
  }
}

// 着信に応答する
export async function acceptCall() {
  if (state.status !== "incoming") return;
  const { invite } = state;
  window.clearTimeout(ringTimer);
  if (!me) throw new Error("ユーザー情報がありません");
  callId = invite.callId;
  groupName = invite.groupName;
  startedAt = Date.now();
  await openMic();
  setState({ status: "active", callId, conversationId: invite.conversationId, groupName, participants: [me], muted: false, startedAt, ringing: false });
  await joinChannel(invite.conversationId);
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
  if (state.status !== "active" && state.status !== "incoming") return;
  if (state.status === "active") {
    channel?.send({ type: "broadcast", event: "leave", payload: { callId, from: me?.id } });
  }
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
  callId = "";
  setState({ status: "idle" });
}
