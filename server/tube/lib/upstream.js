// 外部の Invidious / Piped への通信。インスタンスを順に試して、最初に成功したものを使う。
import { cached } from "./cache.js";

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const INVIDIOUS_VIDEO_LIST_URL =
  "https://raw.githubusercontent.com/ikirikittsuhao-ctrl/Invidious-check/refs/heads/main/lists/video.json";

export const FALLBACK_INVIDIOUS_INSTANCES = [
  "https://invidious.ritoge.com",
  "https://yt.omada.cafe",
  "https://invidious.darkness.services",
  "https://invidious.f5.si",
  "https://invidious.ducks.party",
  "https://y.com.sb",
  "https://super8.absturztau.be",
  "https://inv.zoomerville.com",
  "https://invidious.nerdvpn.de",
  "https://inv.thepixora.com",
];

export const PIPED_INSTANCES = [
  "https://pipedapi.wireway.ch",
  "https://api.piped.private.coffee",
  "https://pipedapi.winscloud.net",
];

const shuffle = (list) => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const cleanBase = (url) => url.trim().replace(/\/+$/, "");

// 一覧（GitHub 上の JSON）を取る。取れなければ既定の一覧を使う
export function getInvidiousInstances(listUrl = INVIDIOUS_VIDEO_LIST_URL) {
  return cached(`inst:${listUrl}`, 10 * 60_000, async () => {
    try {
      const data = await fetchJson(listUrl, { timeout: 4000 });
      const list = (Array.isArray(data) ? data : [])
        .map((item) => (typeof item === "string" ? item : item?.instance))
        .filter((s) => typeof s === "string" && s.trim())
        .map(cleanBase);
      if (list.length) return list;
    } catch {
      // 一覧が取れなくても、既定の一覧で続ける
    }
    return FALLBACK_INVIDIOUS_INSTANCES;
  });
}

export async function fetchJson(url, { timeout = 6000, headers = {} } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Invidious の API（/api/v1 以下）。forceInstance があればそれだけを使う
export async function invidious(path, params = {}, { forceInstance = null, timeout = 5000, tries = 4 } = {}) {
  const bases =
    forceInstance && /^https?:\/\//.test(forceInstance)
      ? [cleanBase(forceInstance)]
      : shuffle(await getInvidiousInstances()).slice(0, tries);

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const qs = query.toString() ? `?${query}` : "";

  let lastError = new Error("Invidious: インスタンスがありません");
  for (const base of bases) {
    try {
      const data = await fetchJson(`${base}/api/v1${path}${qs}`, { timeout });
      return { data, instance: base };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Piped の API。Invidious が全部だめなときの予備
export async function piped(path, { timeout = 5000 } = {}) {
  let lastError = new Error("Piped: インスタンスがありません");
  for (const base of shuffle(PIPED_INSTANCES)) {
    try {
      const data = await fetchJson(`${base}${path}`, { timeout });
      return { data, instance: base };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// 画像などの生データを取る（サムネイル用）
export async function fetchBuffer(url, { timeout = 3000 } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
