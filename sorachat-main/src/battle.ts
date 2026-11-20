import { api, post } from "./api";
import type { Friend } from "./types";

// オンライン対戦（拡張機能の中の対戦）の画面が使う、サーバーの窓口と型。
// サブスク（1週間 200pt）に入っていて、拡張機能を買っていて、情報の許可をしている人だけが対戦できる。

export type BattleSubscription = {
  linked: boolean;
  subscribed: boolean;
  expiresAt: string | null;
  autoRenew: boolean;
  price: number;
  days: number;
};

export type BattleMember = { name: string; state: "invited" | "joined"; ready?: boolean };

export type BattleRoom = {
  id: string;
  gameId: string;
  gameName: string;
  mode: "random" | "friends";
  status: "lobby" | "preparing" | "starting" | "playing" | "closed";
  size: number;
  isHost: boolean;
  seat: number | null;
  players: { seat: number; name: string }[];
  readyUntil: number | null;
  members: BattleMember[];
};

// 準備の画面に出す参加者（アイコン・名前・席）。userId はアイコンの取得にだけ使う
export type BattlePerson = { seat: number; userId: string; name: string; hasAvatar: boolean; avatarVersion: string | null };
export type BattleReadyMember = BattlePerson & { ready: boolean };

export type QueueResult = { status: "waiting" } | { status: "matched"; roomId: string };

// この拡張機能で遊べる友だち。オンラインかどうか・対戦中かも持つ
export type BattleCandidate = Friend & { state: "online" | "offline" | "busy" };

// 友だちを招待できる最大の人数（主催者を除く）
export const INVITE_MAX = 3;
// 準備OKの締め切り（サーバーが時刻を返さなかったときの目安）
export const READY_TIMEOUT_MS = 60_000;

// 支払いの申し込み番号。同じ申し込みの押し直しで二重に払わないよう、1回の操作で作って使い回す
export function newRequestId(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const battleApi = {
  subscription: () => api<BattleSubscription>("/api/battle/subscription"),
  subscribe: (requestId: string) => api<BattleSubscription>("/api/battle/subscription", post({ requestId })),
  setAutoRenew: (autoRenew: boolean) => api<BattleSubscription>("/api/battle/subscription/auto", post({ autoRenew })),
  candidates: async (workId: string) =>
    (await api<{ ok: boolean; friends: BattleCandidate[] }>(`/api/battle/extensions/${encodeURIComponent(workId)}/candidates`)).friends,
  queue: (workId: string, size: number) => api<QueueResult>(`/api/battle/extensions/${encodeURIComponent(workId)}/queue`, post({ size })),
  cancelQueue: (workId: string) => api<{ cancelled: boolean }>(`/api/battle/extensions/${encodeURIComponent(workId)}/queue/cancel`, post()),
  invite: (workId: string, inviteIds: string[]) =>
    api<{ room: BattleRoom }>(`/api/battle/extensions/${encodeURIComponent(workId)}/rooms`, post({ inviteIds })),
  roomAction: (roomId: string, action: "accept" | "decline" | "start" | "ready" | "leave") =>
    api<{ room: BattleRoom | null }>(`/api/battle/rooms/${encodeURIComponent(roomId)}/${action}`, post())
};
