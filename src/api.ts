import type { BanInfo } from "./types";

export class ApiError extends Error {
  status: number;
  // 利用停止中のときだけ入る（期限の表示に使う）
  ban: BanInfo | null;

  constructor(message: string, status: number, ban: BanInfo | null = null) {
    super(message);
    this.status = status;
    this.ban = ban;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: isForm || init.body === undefined ? undefined : { "content-type": "application/json" }
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : "ネットワーク接続に失敗しました";
    throw new ApiError(`${path} への接続に失敗しました（${detail}）。`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const ban: BanInfo | null = data.ban ?? null;
    // 利用停止になっていたら、どの画面からでも利用停止の表示に切り替える
    if (ban) window.dispatchEvent(new CustomEvent<BanInfo>("account-banned", { detail: ban }));
    throw new ApiError(data.error ?? `${path} がエラーを返しました（HTTP ${res.status}）。`, res.status, ban);
  }
  return data as T;
}

export const post = (body?: unknown): RequestInit => ({
  method: "POST",
  body: body === undefined ? undefined : JSON.stringify(body)
});

export const patch = (body: unknown): RequestInit => ({
  method: "POST", // 学校のネットワークがPATCHを通さないためPOSTで送る（サーバー側もPOSTで受ける）
  body: JSON.stringify(body)
});

export const put = (body: unknown): RequestInit => ({
  method: "PUT",
  body: JSON.stringify(body)
});

export const delete_ = (): RequestInit => ({ method: "DELETE" });
