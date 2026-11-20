// 小さなメモリキャッシュ。同じ取得が同時に走らないように、進行中の取得も共有する。
const store = new Map();
const MAX_ENTRIES = 2000;
const inflight = new Map();

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.val;
}

export function cacheSet(key, val, ttlMs) {
  if (store.size >= MAX_ENTRIES) {
    store.delete(store.keys().next().value);
  }
  store.set(key, { val, exp: Date.now() + ttlMs });
}

// fn の結果を ttlMs のあいだ覚える（null / undefined は覚えない）
export function cached(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    try {
      const val = await fn();
      if (val !== null && val !== undefined) cacheSet(key, val, ttlMs);
      return val;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}
