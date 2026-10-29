import type { WebSocket } from "ws";

const OPEN = 1;
const sockets = new Map<string, Set<WebSocket>>();
// 各接続の状態: 画面を見ているか・その端末のWeb Pushの宛先（endpoint）
type Viewing = { visible: boolean; endpoint: string | null };
const viewing = new WeakMap<WebSocket, Viewing>();

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

export function setViewing(ws: WebSocket, visible: boolean, endpoint: string | null) {
  viewing.set(ws, { visible, endpoint });
}

// 画面を見ている「端末」の通知先一覧。その端末にはWeb Pushを送らない（同じ端末で二重に出ないように）。
// 別の端末（例: 開いたままのパソコン）が見ていても、スマホへの通知は止めない。
export function activeEndpoints(userId: string): Set<string> {
  const result = new Set<string>();
  const set = sockets.get(userId);
  if (!set) return result;
  for (const ws of set) {
    const state = viewing.get(ws);
    if (ws.readyState === OPEN && state?.visible && state.endpoint) result.add(state.endpoint);
  }
  return result;
}

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
