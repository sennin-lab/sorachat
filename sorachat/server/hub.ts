import type { WebSocket } from "ws";

const OPEN = 1;
const sockets = new Map<string, Set<WebSocket>>();
// 画面が前面に出ているかどうか。接続直後は「見ていない」扱いにして、クライアントが報告するまでは通知を送る
const visible = new WeakMap<WebSocket, boolean>();

export function addSocket(userId: string, ws: WebSocket) {
  const set = sockets.get(userId) ?? new Set<WebSocket>();
  set.add(ws);
  sockets.set(userId, set);
  visible.set(ws, false);
}

export function removeSocket(userId: string, ws: WebSocket) {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) sockets.delete(userId);
}

export function setVisible(ws: WebSocket, isVisible: boolean) {
  visible.set(ws, isVisible);
}

// iOSではバックグラウンドのソケットが残ったままになるため、接続があるだけでは「オンライン」と判断しない
export function isOnline(userId: string) {
  const set = sockets.get(userId);
  if (!set) return false;
  for (const ws of set) if (ws.readyState === OPEN && visible.get(ws)) return true;
  return false;
}

export function sendToUser(userId: string, payload: unknown) {
  const set = sockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === OPEN) ws.send(data);
}
