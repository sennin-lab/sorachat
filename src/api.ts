export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError(data.error ?? `${path} がエラーを返しました（HTTP ${res.status}）。`, res.status);
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
