// オンライン対戦の部屋と待ち行列（メモリ上。サーバーが再起動すると消えます。通話の部屋と同じ考え方）。
// ・ランダム：同じ拡張機能・同じ人数の待ち行列に、必要な人数がそろったら「準備」に入る。
// ・友だち：主催者が友だちを招待する。招待された人が承諾し、主催者が「開始」を押したら「準備」に入る。
// ・準備：参加している全員が「準備OK」を押すまで、対戦は始まらない（時間切れ・途中で抜けたら取り消し）。
// ・中の データ は、サーバーは読まずに、同じ部屋の人へ中継するだけ（ポイントや結果の判定は拡張機能の作者が書く）。
// 通知は notify（送り先の人と中身）で送る。テストでは notify を差し替えて、WebSocket なしで確かめる。
// 閉じている端末への Web Push は、battle.ts が notify の中で送る。
import { randomUUID } from "node:crypto";
import { BATTLE } from "./battleRules.js";

export class BattleError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type RoomStatus = "lobby" | "preparing" | "playing" | "closed";
export type Member = { userId: string; name: string; state: "invited" | "joined"; ready: boolean };
export type Room = {
  id: string;
  gameId: string;
  gameName: string;
  hostId: string;
  size: number;
  mode: "random" | "friends";
  status: RoomStatus;
  createdAt: number;
  closedAt: number | null;
  // 準備OKの締め切り（準備中だけ入る）
  readyUntil: number | null;
  members: Member[];
};
type Queued = { userId: string; name: string; gameId: string; gameName: string; size: number; at: number };

export type Notify = (userId: string, payload: Record<string, unknown>) => void;
let notify: Notify = () => undefined;
export function setBattleNotifier(next: Notify) {
  notify = next;
}

const rooms = new Map<string, Room>();
// 参加している部屋（承諾済み・準備中・対戦中）。招待だけの人は含まない
const roomOf = new Map<string, string>();
const queue: Queued[] = [];
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 参加している人（承諾済み）の並び。席の番号（seat）は、この並びの順番
const joinedOf = (room: Room) => room.members.filter((m) => m.state === "joined");
const seatOf = (room: Room, userId: string) => joinedOf(room).findIndex((m) => m.userId === userId);
const playersOf = (room: Room) => joinedOf(room).map((m, seat) => ({ seat, name: m.name }));

// 対戦の中か、相手を探している最中か
export function isBusy(userId: string): boolean {
  return roomOf.has(userId) || queue.some((q) => q.userId === userId);
}
const busy = isBusy;

// 名前だけを送る（ほかの人の ID は、拡張機能に渡さない）
function announce(room: Room, targets: Member[], event: string, extra: Record<string, unknown> = {}) {
  for (const m of targets) {
    notify(m.userId, { type: "battle", roomId: room.id, event, gameId: room.gameId, ...extra, seat: seatOf(room, m.userId) });
  }
}

// 準備に入る：参加している全員に「準備OKを押してください」を送る。まだ始めない
function beginPreparing(room: Room) {
  room.status = "preparing";
  room.members = joinedOf(room);
  room.readyUntil = Date.now() + BATTLE.readyTimeoutMs;
  for (const m of room.members) {
    m.ready = false;
    roomOf.set(m.userId, room.id);
  }
  const players = playersOf(room);
  for (const m of room.members) {
    notify(m.userId, {
      type: "battle",
      roomId: room.id,
      gameId: room.gameId,
      event: "prepare",
      mode: room.mode,
      size: room.size,
      seat: seatOf(room, m.userId),
      players,
      readyUntil: room.readyUntil
    });
  }
}

// 全員が準備OKを押したら、対戦を始める
function startRoom(room: Room) {
  room.status = "playing";
  room.readyUntil = null;
  const players = playersOf(room);
  for (const m of room.members) {
    notify(m.userId, {
      type: "battle",
      roomId: room.id,
      gameId: room.gameId,
      event: "started",
      mode: room.mode,
      size: room.size,
      seat: seatOf(room, m.userId),
      players
    });
  }
}

// ---- ランダムの対戦 ----

export function enqueueRandom(args: { userId: string; name: string; gameId: string; gameName: string; size: number }): { status: "waiting" } | { status: "matched"; roomId: string } {
  if (busy(args.userId)) throw new BattleError(409, "busy", "すでに対戦の中か、相手を探しています。");
  queue.push({ ...args, at: Date.now() });
  const same = queue.filter((q) => q.gameId === args.gameId && q.size === args.size);
  if (same.length < args.size) return { status: "waiting" };

  const group = same.slice(0, args.size);
  for (const q of group) queue.splice(queue.indexOf(q), 1);
  const room: Room = {
    id: randomUUID(),
    gameId: args.gameId,
    gameName: group[0].gameName,
    hostId: group[0].userId,
    size: args.size,
    mode: "random",
    status: "lobby",
    createdAt: Date.now(),
    closedAt: null,
    readyUntil: null,
    members: group.map((q) => ({ userId: q.userId, name: q.name, state: "joined" as const, ready: false }))
  };
  rooms.set(room.id, room);
  beginPreparing(room);
  if (!group.some((q) => q.userId === args.userId)) return { status: "waiting" };
  return { status: "matched", roomId: room.id };
}

export function cancelQueue(userId: string): boolean {
  let removed = false;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].userId === userId) {
      queue.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

// ---- 友だちとの対戦（招待） ----

// 招待の知らせの中身（接続中の画面へも、閉じている端末への通知にも使う）
function inviteOf(room: Room) {
  const host = room.members.find((m) => m.userId === room.hostId);
  return {
    type: "battle-invite",
    roomId: room.id,
    gameId: room.gameId,
    gameName: room.gameName,
    hostName: host?.name ?? ""
  };
}

export function createLobby(args: {
  hostId: string;
  hostName: string;
  gameId: string;
  gameName: string;
  invitees: { userId: string; name: string }[];
}): Room {
  if (busy(args.hostId)) throw new BattleError(409, "busy", "すでに対戦の中か、相手を探しています。");
  const size = args.invitees.length + 1;
  const room: Room = {
    id: randomUUID(),
    gameId: args.gameId,
    gameName: args.gameName,
    hostId: args.hostId,
    size,
    mode: "friends",
    status: "lobby",
    createdAt: Date.now(),
    closedAt: null,
    readyUntil: null,
    members: [
      { userId: args.hostId, name: args.hostName, state: "joined", ready: false },
      ...args.invitees.map((i) => ({ userId: i.userId, name: i.name, state: "invited" as const, ready: false }))
    ]
  };
  rooms.set(room.id, room);
  roomOf.set(args.hostId, room.id);
  const invite = inviteOf(room);
  for (const invitee of args.invitees) notify(invitee.userId, invite);
  return room;
}

// まだ承諾していない招待（接続し直したときに、画面へもう一度出すため）
export function pendingInvitesOf(userId: string) {
  const now = Date.now();
  const list: ReturnType<typeof inviteOf>[] = [];
  for (const room of rooms.values()) {
    if (room.status !== "lobby" || now - room.createdAt > BATTLE.lobbyTtlMs) continue;
    if (!room.members.some((m) => m.userId === userId && m.state === "invited")) continue;
    list.push(inviteOf(room));
  }
  return list;
}

// 招待への返事（承諾・断る）
export function respondInvite(userId: string, roomId: string, accept: boolean): Room {
  const room = rooms.get(roomId);
  if (!room || room.status !== "lobby") throw new BattleError(410, "closed", "この招待は終わっています。");
  const member = room.members.find((m) => m.userId === userId);
  if (!member || member.state !== "invited") throw new BattleError(404, "not_invited", "この招待は見つかりません。");
  if (accept) {
    if (busy(userId)) throw new BattleError(409, "busy", "ほかの対戦の中です。終わってから参加してください。");
    member.state = "joined";
    roomOf.set(userId, room.id);
    announce(room, joinedOf(room), "joined", { name: member.name });
  } else {
    room.members = room.members.filter((m) => m !== member);
    announce(room, room.members, "declined", { name: member.name });
  }
  return room;
}

// 主催者が始める（参加した人が2人以上のとき）。すぐには始めず、全員の準備OKを待つ
export function startLobby(hostId: string, roomId: string): Room {
  const room = rooms.get(roomId);
  if (!room || room.status !== "lobby" || room.hostId !== hostId) throw new BattleError(404, "not_found", "部屋が見つかりません。");
  if (joinedOf(room).length < BATTLE.sizeMin) {
    throw new BattleError(400, "need_players", "もう1人以上が参加すると開始できます。");
  }
  const dropped = room.members.filter((m) => m.state === "invited");
  beginPreparing(room);
  announce(room, dropped, "invite_closed");
  return room;
}

// 準備OK（準備中の人だけ）。全員がそろったら、対戦が始まる
export function readyUp(userId: string, roomId: string): Room {
  const room = rooms.get(roomId);
  if (!room || room.status !== "preparing") {
    throw new BattleError(409, "not_preparing", "準備OKを押せるのは、対戦の準備中だけです。");
  }
  const member = room.members.find((m) => m.userId === userId && m.state === "joined");
  if (!member) throw new BattleError(403, "not_in_room", "この対戦には参加していません。");
  if (member.ready) return room;
  member.ready = true;
  announce(room, joinedOf(room), "ready", { name: member.name });
  if (joinedOf(room).every((m) => m.ready)) startRoom(room);
  return room;
}

// 部屋から出る
// ・待機中：主催者が出たら閉じる。招待された人が出ても、部屋は続く
// ・準備中：誰かが抜けたら、準備を取り消して閉じる（マッチングは成立させない）
// ・対戦中：残りが2人未満になれば閉じる
export function leaveRoom(userId: string, roomId: string) {
  const room = rooms.get(roomId);
  if (!room || room.status === "closed") return;
  const member = room.members.find((m) => m.userId === userId);
  if (!member) return;
  if (room.status === "lobby") {
    if (room.hostId === userId) {
      closeRoom(room, "host_left");
      return;
    }
    const seat = seatOf(room, userId);
    room.members = room.members.filter((m) => m !== member);
    roomOf.delete(userId);
    announce(room, joinedOf(room), "left", { name: member.name, leftSeat: seat });
    return;
  }
  if (room.status === "preparing") {
    closeRoom(room, room.hostId === userId ? "host_left" : "opponent_left");
    return;
  }
  // 対戦中
  const seat = seatOf(room, userId);
  room.members = room.members.filter((m) => m !== member);
  roomOf.delete(userId);
  if (joinedOf(room).length < BATTLE.sizeMin) {
    closeRoom(room, "opponent_left");
    return;
  }
  announce(room, joinedOf(room), "left", { name: member.name, leftSeat: seat });
}

function closeRoom(room: Room, reason: string, at = Date.now()) {
  room.status = "closed";
  room.closedAt = at;
  room.readyUntil = null;
  for (const m of room.members) roomOf.delete(m.userId);
  announce(room, room.members, "closed", { reason });
}

// 対戦の中で、データを相手に中継する（参加している人だけ・対戦中だけ）
export function relay(userId: string, roomId: string, payload: unknown): void {
  const room = rooms.get(roomId);
  if (!room || room.status !== "playing") throw new BattleError(409, "not_playing", "対戦中ではありません。");
  const from = seatOf(room, userId);
  if (from < 0) throw new BattleError(403, "not_in_room", "この対戦には参加していません。");
  for (const m of joinedOf(room)) {
    if (m.userId === userId) continue;
    notify(m.userId, { type: "battle", roomId: room.id, gameId: room.gameId, event: "message", from, payload });
  }
}

// 画面の部屋の状態（今の席・参加している人・招待や準備OKの状態）
export function roomView(userId: string, roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const mine = room.members.find((m) => m.userId === userId);
  if (!mine) return null;
  return {
    id: room.id,
    gameId: room.gameId,
    gameName: room.gameName,
    mode: room.mode,
    status: room.status,
    size: room.size,
    isHost: room.hostId === userId,
    seat: seatOf(room, userId),
    players: playersOf(room),
    readyUntil: room.readyUntil,
    members: room.members.map((m) => ({ name: m.name, state: m.state, ready: m.ready }))
  };
}

// 参加している部屋の番号（同じ人が2つの対戦に入らないように、呼び出し側が確かめる）
export function roomIdOf(userId: string): string | null {
  return roomOf.get(userId) ?? null;
}

// ---- 接続の状態（スマホの画面オフなどで一時的に切れても、猶予の間は対戦を続けられる） ----

export function userOnline(userId: string) {
  const timer = offlineTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(userId);
  }
}

export function userOffline(userId: string) {
  if (offlineTimers.has(userId)) return;
  const timer = setTimeout(() => {
    offlineTimers.delete(userId);
    leaveAll(userId);
  }, BATTLE.offlineGraceMs);
  timer.unref?.();
  offlineTimers.set(userId, timer);
}

function leaveAll(userId: string) {
  cancelQueue(userId);
  for (const room of [...rooms.values()]) {
    if (room.status !== "closed" && room.members.some((m) => m.userId === userId)) leaveRoom(userId, room.id);
  }
}

// ---- 定期の掃除（古い待ち・放置された招待・準備の時間切れ・終わった部屋） ----

export function pruneBattles(now = Date.now()) {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const q = queue[i];
    if (now - q.at > BATTLE.queueTtlMs) {
      queue.splice(i, 1);
      notify(q.userId, { type: "battle", roomId: null, gameId: q.gameId, event: "queue_expired" });
    }
  }
  for (const room of [...rooms.values()]) {
    if (room.status === "lobby" && now - room.createdAt > BATTLE.lobbyTtlMs) closeRoom(room, "timeout", now);
    // 準備OKが揃わないまま締め切りを過ぎたら、取り消す
    if (room.status === "preparing" && room.readyUntil !== null && now > room.readyUntil) closeRoom(room, "ready_timeout", now);
    if (room.status === "closed" && room.closedAt !== null && now - room.closedAt > BATTLE.closedKeepMs) rooms.delete(room.id);
  }
}

// テスト・再起動の確認用
export function resetBattlesForTest() {
  rooms.clear();
  roomOf.clear();
  queue.length = 0;
  for (const timer of offlineTimers.values()) clearTimeout(timer);
  offlineTimers.clear();
}
