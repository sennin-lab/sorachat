// 拡張機能の「オンライン対戦」の決まり（DB・通信には触れない純粋な関数だけ）。
// サブスクの料金・期間、対戦の人数、依頼の形の検査、期限の計算をここに置く。

export const BATTLE = {
  subscriptionPoints: 200, // 1週間の料金（仙人アカウントのポイント）
  subscriptionDays: 7,
  sizeMin: 2, // 対戦の人数（最少・最多）
  sizeMax: 4,
  inviteMax: 3, // 友だちから誘える人数（主催者を入れて最大 sizeMax 人）
  lobbyTtlMs: 3 * 60_000, // 招待してから、開始されずに消えるまで
  readyTimeoutMs: 60_000, // マッチングが決まってから、全員が準備OKを押すまでの時間
  queueTtlMs: 5 * 60_000, // ランダムの待ち行列に残れる時間
  closedKeepMs: 60_000, // 終わった部屋を、通知の取りこぼし用に残す時間
  offlineGraceMs: 20_000, // 接続が切れても、この時間内に戻れば対戦を続けられる（スマホの画面オフ対策）
  messageMaxBytes: 2048, // 対戦の中で送れる1回のデータ（JSON の文字数の目安）
  messagesPerSecond: 20 // 1つの接続から1秒に送れる回数
} as const;

export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

// 有効期限の中にいるか（期限ちょうどは切れた扱い）
export function isSubscribed(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}

// 延長後の期限。まだ有効なら今の期限に足し、切れていれば今から数える（切れた分の日数は貯まらない）
export function extendedExpiry(current: Date | null, now: Date): Date {
  const base = current && current.getTime() > now.getTime() ? current.getTime() : now.getTime();
  return new Date(base + BATTLE.subscriptionDays * 24 * 60 * 60_000);
}

// 自動更新の支払いの押し直しを同じ支払いとして扱うための ID（切れた期限ごとに1回だけ）
export function autoRenewRequestId(expiredAt: Date | null): string {
  return `auto-${expiredAt ? expiredAt.getTime() : 0}`;
}

export function checkSubscribeRequest(body: unknown): { ok: true; requestId: string } | { ok: false; error: string } {
  const requestId = typeof (body as { requestId?: unknown } | null)?.requestId === "string" ? (body as { requestId: string }).requestId : "";
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: "申し込みの番号が正しくありません。もう一度お試しください。" };
  return { ok: true, requestId };
}

export function checkAutoRenewRequest(body: unknown): { ok: true; autoRenew: boolean } | { ok: false; error: string } {
  const value = (body as { autoRenew?: unknown } | null)?.autoRenew;
  if (typeof value !== "boolean") return { ok: false, error: "自動更新のオン・オフを指定してください。" };
  return { ok: true, autoRenew: value };
}

// 人数（2〜4人）。指定がなければ 2 人
export function checkSize(value: unknown): { ok: true; size: number } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, size: BATTLE.sizeMin };
  if (typeof value !== "number" || !Number.isInteger(value) || value < BATTLE.sizeMin || value > BATTLE.sizeMax) {
    return { ok: false, error: `対戦の人数は ${BATTLE.sizeMin}〜${BATTLE.sizeMax} 人で指定してください。` };
  }
  return { ok: true, size: value };
}

// 友だちを招待するときの依頼（招待する人の ID を、重複なく 1〜3 人）
export function checkInviteRequest(body: unknown): { ok: true; inviteIds: string[] } | { ok: false; error: string } {
  const list = (body as { inviteIds?: unknown } | null)?.inviteIds;
  if (!Array.isArray(list) || list.some((id) => typeof id !== "string")) {
    return { ok: false, error: "招待する友だちを選んでください。" };
  }
  const unique = [...new Set(list as string[])];
  if (unique.length < 1 || unique.length > BATTLE.inviteMax) {
    return { ok: false, error: `招待できるのは 1〜${BATTLE.inviteMax} 人までです。` };
  }
  return { ok: true, inviteIds: unique };
}

// 対戦の中で送るデータの大きさ（送れる形か・大きすぎないか）
export function checkPayload(payload: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (payload === undefined) return { ok: false, error: "送るデータがありません。" };
  let json: string;
  try {
    json = JSON.stringify(payload) ?? "";
  } catch {
    return { ok: false, error: "送るデータを読み取れませんでした。" };
  }
  if (!json) return { ok: false, error: "送るデータがありません。" };
  if (json.length > BATTLE.messageMaxBytes) {
    return { ok: false, error: `1回に送れるのは ${BATTLE.messageMaxBytes} 文字までです。` };
  }
  return { ok: true, json };
}
