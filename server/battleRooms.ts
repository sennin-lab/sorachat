// オンライン対戦の部屋と待ち行列（メモリ上。サーバーが再起動すると消えます。通話の部屋と同じ考え方）。
// ・ランダム：同じ拡張機能・同じ人数の待ち行列に、必要な人数がそろったら部屋を作って始める。
// ・友だち：主催者が友だちを招待する。招待された人が承諾し、主催者が「開始」を押したら始める。
// ・中の データ は、サーバーは読まずに、同じ部屋の人へ中継するだけ（ポイントや結果の判定は拡張機能の作者が書く）。
// 通知は notify（送り先の人と中身）で送る。テストでは notify を差し替えて、WebSocket なしで確かめる。
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

export type RoomStatus = "lobby" | "playing" | "closed";
export type Member = { userId: string; name: string; state: "invited" | "joined" };
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
  members: Member[];
};
type Queued = { userId: string; name: string; gameId: string; gameName: string; size: number; at: number };

export type Notify = (userId: string, payload: Record<string, unknown>) => void;
let notify: Notify = () => undefined;
export function setBattleNotifier(next: Notify) {
  notify = next;
}

const rooms = new Map<string, Room>();
// 参加している部屋（承諾済み・対戦中）。招待だけの人は含まない
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

function startRoom(room: Room) {
  room.status = "playing";
  room.members = joinedOf(room);
  for (const m of room.members) roomOf.set(m.userId, room.id);
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
    members: group.map((q) => ({ userId: q.userId, name: q.name, state: "joined" as const }))
  };
  rooms.set(room.id, room);
  startRoom(room);
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
    members: [
      { userId: args.hostId, name: args.hostName, state: "joined" },
      ...args.invitees.map((i) => ({ userId: i.userId, name: i.name, state: "invited" as const }))
    ]
  };
  rooms.set(room.id, room);
  roomOf.set(args.hostId, room.id);
  for (const invitee of args.invitees) {
    notify(invitee.userId, {
      type: "battle-invite",
      roomId: room.id,
      gameId: room.gameId,
      gameName: room.gameName,
      hostName: args.hostName
    });
  }
  return room;
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

// 主催者が始める（参加した人が2人以上のとき）
export function startLobby(hostId: string, roomId: string): Room {
  const room = rooms.get(roomId);
  if (!room || room.status !== "lobby" || room.hostId !== hostId) throw new BattleError(404, "not_found", "部屋が見つかりません。");
  if (joinedOf(room).length < BATTLE.sizeMin) {
    throw new BattleError(400, "need_players", "もう1人以上が参加すると開始できます。");
  }
  const dropped = room.members.filter((m) => m.state === "invited");
  startRoom(room);
  announce(room, dropped, "invite_closed");
  return room;
}

// 部屋から出る（主催者が出た場合、待機中なら部屋は閉じる。対戦中は、残りが2人未満になれば閉じる）
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

// 画面の部屋の状態（今の席・参加している人・招待の状態）
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
    members: room.members.map((m) => ({ name: m.name, state: m.state }))
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

// ---- 定期の掃除（古い待ち・放置された招待・終わった部屋） ----

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
