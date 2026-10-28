import type { WebSocket } from "ws";

const OPEN = 1;
const sockets = new Map<string, Set<WebSocket>>();

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

export const isOnline = (userId: string) => sockets.has(userId);

export function sendToUser(userId: string, payload: unknown) {
  const set = sockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === OPEN) ws.send(data);
}
