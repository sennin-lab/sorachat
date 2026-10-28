export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: isForm || init.body === undefined ? undefined : { "content-type": "application/json" }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "通信に失敗しました。", res.status);
  return data as T;
}

export const post = (body?: unknown): RequestInit => ({
  method: "POST",
  body: body === undefined ? undefined : JSON.stringify(body)
});

export const patch = (body: unknown): RequestInit => ({
  method: "PATCH",
  body: JSON.stringify(body)
});

export const put = (body: unknown): RequestInit => ({
  method: "PUT",
  body: JSON.stringify(body)
});

export const delete_ = (): RequestInit => ({ method: "DELETE" });
