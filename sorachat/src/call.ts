import { useEffect, useState } from "react";
import { getClient } from "./realtime";

export type Peer = { id: string; name: string; hasAvatar: boolean };

export type CallState =
  | { status: "idle" }
  | { status: "outgoing"; callId: string; peer: Peer }
  | { status: "incoming"; callId: string; peer: Peer; offer: string }
  | { status: "active"; callId: string; peer: Peer; since: number | null; muted: boolean };

const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const RING_MS = 40_000;

async function send(userId: string, event: string, payload: Record<string, unknown>) {
  const client = await getClient();
  const channel = client.channel(`call:${userId}`, { config: { private: true } });
  await new Promise<void>((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error("通話先に接続できません。"));
    });
  });
  await channel.send({ type: "broadcast", event, payload });
  await client.removeChannel(channel);
}

function waitForIce(pc: RTCPeerConnection) {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
    window.setTimeout(resolve, 3000);
  });
}

class CallController {
  private state: CallState = { status: "idle" };
  private listeners = new Set<(state: CallState) => void>();
  private me: Peer | null = null;
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio = new Audio();
  private ringTimer = 0;

  constructor() {
    this.audio.autoplay = true;
  }

  getState() {
    return this.state;
  }

  subscribe(listener: (state: CallState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(state: CallState) {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
  }

  async init(me: Peer) {
    if (this.me) return;
    this.me = me;
    const client = await getClient();
    client
      .channel(`call:${me.id}`, { config: { private: true, broadcast: { self: false } } })
      .on("broadcast", { event: "invite" }, ({ payload }) => this.onInvite(payload))
      .on("broadcast", { event: "accept" }, ({ payload }) => this.onAccept(payload))
      .on("broadcast", { event: "decline" }, ({ payload }) => this.onRemoteEnd(payload.callId))
      .on("broadcast", { event: "end" }, ({ payload }) => this.onRemoteEnd(payload.callId))
      .subscribe();
  }

  private async microphone() {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  private createPeer(callId: string, peer: Peer) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.ontrack = (event) => {
      this.audio.srcObject = event.streams[0];
      this.audio.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && this.state.status !== "idle" && this.state.callId === callId) {
        this.set({ status: "active", callId, peer, since: Date.now(), muted: false });
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (this.state.status !== "idle" && this.state.callId === callId) this.finish(true);
      }
    };
    this.pc = pc;
    return pc;
  }

  async start(peer: Peer) {
    if (this.state.status !== "idle" || !this.me) return;
    const callId = crypto.randomUUID();
    this.set({ status: "outgoing", callId, peer });
    try {
      this.stream = await this.microphone();
      const pc = this.createPeer(callId, peer);
      this.stream.getTracks().forEach((track) => pc.addTrack(track, this.stream!));
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      await send(peer.id, "invite", {
        callId,
        fromId: this.me.id,
        fromName: this.me.name,
        fromHasAvatar: this.me.hasAvatar,
        sdp: pc.localDescription!.sdp
      });
      this.ringTimer = window.setTimeout(() => this.hangup(), RING_MS);
    } catch (error) {
      this.fail(error);
    }
  }

  private onInvite(payload: any) {
    if (this.state.status !== "idle") {
      send(payload.fromId, "decline", { callId: payload.callId }).catch(() => undefined);
      return;
    }
    this.set({
      status: "incoming",
      callId: payload.callId,
      peer: { id: payload.fromId, name: payload.fromName, hasAvatar: payload.fromHasAvatar },
      offer: payload.sdp
    });
  }

  async accept() {
    const state = this.state;
    if (state.status !== "incoming") return;
    try {
      this.stream = await this.microphone();
      const pc = this.createPeer(state.callId, state.peer);
      this.stream.getTracks().forEach((track) => pc.addTrack(track, this.stream!));
      await pc.setRemoteDescription({ type: "offer", sdp: state.offer });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIce(pc);
      await send(state.peer.id, "accept", { callId: state.callId, sdp: pc.localDescription!.sdp });
      this.set({ status: "active", callId: state.callId, peer: state.peer, since: null, muted: false });
    } catch (error) {
      this.fail(error);
    }
  }

  private async onAccept(payload: any) {
    const state = this.state;
    if (state.status !== "outgoing" || state.callId !== payload.callId || !this.pc) return;
    clearTimeout(this.ringTimer);
    await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    this.set({ status: "active", callId: state.callId, peer: state.peer, since: null, muted: false });
  }

  decline() {
    const state = this.state;
    if (state.status !== "incoming") return;
    send(state.peer.id, "decline", { callId: state.callId }).catch(() => undefined);
    this.finish(false);
  }

  hangup() {
    const state = this.state;
    if (state.status === "idle" || !("peer" in state)) return;
    send(state.peer.id, "end", { callId: state.callId }).catch(() => undefined);
    this.finish(false);
  }

  toggleMute() {
    const state = this.state;
    if (state.status !== "active") return;
    const muted = !state.muted;
    this.stream?.getAudioTracks().forEach((track) => (track.enabled = !muted));
    this.set({ ...state, muted });
  }

  private onRemoteEnd(callId: string) {
    if ("callId" in this.state && this.state.callId === callId) this.finish(false);
  }

  private fail(error: unknown) {
    alert(error instanceof Error ? error.message : "通話を開始できませんでした。マイクの許可を確認してください。");
    this.finish(false);
  }

  private finish(_dropped: boolean) {
    clearTimeout(this.ringTimer);
    this.pc?.close();
    this.pc = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.audio.srcObject = null;
    this.set({ status: "idle" });
  }
}

export const calls = new CallController();

export function useCall() {
  const [state, setState] = useState<CallState>(calls.getState());
  useEffect(() => calls.subscribe(setState), []);
  return state;
}
