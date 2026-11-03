// 進行中のグループ通話（メモリ上。サーバーが再起動すると消えます）
// calls.ts（発信・参加・退出）と messages.ts（トークの「電話に参加」カード）の両方から使います。
export type CallRecord = { conversationId: string; startedAt: number; secret: string; participants: Set<string> };

export const activeCalls = new Map<string, CallRecord>();
const MAX_CALL_AGE_MS = 12 * 60 * 60_000;

export function pruneCalls() {
  const now = Date.now();
  for (const [id, record] of activeCalls) if (now - record.startedAt > MAX_CALL_AGE_MS) activeCalls.delete(id);
}

// 進行中の通話を返す（終わっている・古すぎる場合は undefined）
export function findCall(callId: string): CallRecord | undefined {
  const record = activeCalls.get(callId);
  if (!record) return undefined;
  if (Date.now() - record.startedAt > MAX_CALL_AGE_MS) {
    activeCalls.delete(callId);
    return undefined;
  }
  return record;
}
