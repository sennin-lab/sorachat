import type { WebSocket } from "ws";

const OPEN = 1;
const sockets = new Map<string, Set<WebSocket>>();
// 各接続が「画面を開いて見ているか」（クライアントが visibilitychange で知らせる）
const viewing = new WeakMap<WebSocket, boolean>();

export function addSocket(userId: string, ws: WebSocket) {
  const set = sockets.get(userId) ?? new Set<WebSocket>();
  set.add(ws);
  sockets.set(userId, set);
}

export function removeSocket(userId: string, ws: WebSocket) {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) sockets.delete(userId);
}

export function setViewing(ws: WebSocket, value: boolean) {
  viewing.set(ws, value);
}

// 接続があるだけでは「見ている」と判断しない。アプリを裏に回したスマホは接続が残ることがあり、
// その間に通知を止めてしまうと届かなくなるため、画面を見ている接続があるときだけ通知を止める。
export const isActive = (userId: string) => {
  const set = sockets.get(userId);
  if (!set) return false;
  for (const ws of set) if (ws.readyState === OPEN && viewing.get(ws)) return true;
  return false;
};

// 利用停止になったユーザーの接続をすべて閉じる
export function disconnectUser(userId: string) {
  const set = sockets.get(userId);
  if (!set) return;
  for (const ws of set) ws.close(4003, "banned");
}

export function sendToUser(userId: string, payload: unknown) {
  const set = sockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === OPEN) ws.send(data);
}
