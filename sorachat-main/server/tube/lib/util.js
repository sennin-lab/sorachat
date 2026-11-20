// 小さな共通関数
export function withTimeout(promise, ms, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    promise.catch(() => fallback),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

export const VIDEO_ID_RE = /^[\w-]{6,20}$/;

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
