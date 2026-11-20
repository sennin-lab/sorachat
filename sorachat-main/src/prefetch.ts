import { api } from "./api";
import { loadMessagesDb, saveMessages } from "./cache";
import { isPrivateBrowsing } from "./idb";
import type { Conversation, Message } from "./types";

// 一覧にあるトークのメッセージを、開く前に先に保存しておく。
// ・未読のトークを先に読む
// ・手元の保存より新しいメッセージがあるトークだけ取りに行く（転送量を抑える）
// ・非公開ブラウズ中は行わない（開いたときに必要な分だけ読む）
const MAX_PREFETCH = 20;
let running = false;

type Handlers = {
  start: (id: string) => void;
  done: (id: string) => void;
};

const newestOf = (list: Message[]) => list[list.length - 1]?.createdAt ?? "";

export async function prefetchMessages(list: Conversation[], handlers: Handlers): Promise<void> {
  if (running) return;
  if (await isPrivateBrowsing()) return;

  const ordered = [...list]
    .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.lastMessageAt.localeCompare(a.lastMessageAt))
    .slice(0, MAX_PREFETCH);

  running = true;
  try {
    for (const c of ordered) {
      const stored = await loadMessagesDb(c.id);
      if (stored.length > 0 && newestOf(stored) >= c.lastMessageAt) continue;

      handlers.start(c.id);
      try {
        const fresh = await api<Message[]>(`/api/dm/${c.id}/messages`);
        // 保存済みの古い分は残したまま、新しい分を足す（ID で重複を除く）
        const map = new Map<string, Message>();
        for (const m of [...stored, ...fresh]) map.set(m.id, m);
        const merged = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        saveMessages(c.id, merged);
      } catch {
        // 1件失敗しても、残りは続ける
      } finally {
        handlers.done(c.id);
      }
    }
  } finally {
    running = false;
  }
}
