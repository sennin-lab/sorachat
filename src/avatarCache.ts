import type { Friend } from "./types";

// 友だちの一覧と、そのプロフィール画像を localStorage に保存する。
// 画面を開いたとき、データベースへ問い合わせる前に保存済みの画像をすぐ表示するため。
// 画像が変わった（版が違う）ものだけ取り直す。
const FRIENDS_KEY = "sorachat.friends";
const avatarKey = (userId: string) => `sorachat.avatar.${userId}`;
const AVATAR_EVENT = "sorachat:avatars";
// 1枚の画像の上限（バイト）。localStorage の容量（約5MB）を圧迫しないため
const MAX_AVATAR_BYTES = 120_000;

type StoredAvatar = { v: string; d: string };

const readAvatar = (userId: string): StoredAvatar | null => {
  try {
    const raw = localStorage.getItem(avatarKey(userId));
    return raw ? (JSON.parse(raw) as StoredAvatar) : null;
  } catch {
    return null;
  }
};

// 保存済みの画像（データURL）。なければ null
export const cachedAvatar = (userId: string): string | null => readAvatar(userId)?.d ?? null;

// 保存済みの友だち一覧（画面を開いた直後に表示するため）
export const cachedFriends = (): Friend[] => {
  try {
    const raw = localStorage.getItem(FRIENDS_KEY);
    return raw ? (JSON.parse(raw) as Friend[]) : [];
  } catch {
    return [];
  }
};

export const saveFriends = (list: Friend[]) => {
  try {
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(list));
  } catch {
    // 容量が足りないときは保存しない（表示は通常どおり）
  }
};

// 画像が保存されたことを画面に知らせる（Avatar が保存済みの画像に差し替える）
export const onAvatarCacheChange = (callback: () => void) => {
  window.addEventListener(AVATAR_EVENT, callback);
  return () => window.removeEventListener(AVATAR_EVENT, callback);
};

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// 友だちの画像を保存する。版が同じなら何もしない。
// 友だちでなくなった人の保存分は消す。
export async function syncFriendAvatars(friends: Friend[]): Promise<void> {
  let changed = false;
  try {
    const keep = new Set(friends.map((f) => f.id));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("sorachat.avatar.") && !keep.has(key.slice("sorachat.avatar.".length))) {
        localStorage.removeItem(key);
        changed = true;
      }
    }
  } catch {
    // 読めない環境では何もしない
  }

  for (const friend of friends) {
    try {
      if (!friend.hasAvatar) {
        if (readAvatar(friend.id)) {
          localStorage.removeItem(avatarKey(friend.id));
          changed = true;
        }
        continue;
      }
      const version = friend.avatarVersion ?? "";
      if (readAvatar(friend.id)?.v === version) continue;

      const res = await fetch(`/api/users/${friend.id}/avatar`, { credentials: "same-origin" });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size > MAX_AVATAR_BYTES) continue;
      const data = await toDataUrl(blob);
      localStorage.setItem(avatarKey(friend.id), JSON.stringify({ v: version, d: data } satisfies StoredAvatar));
      changed = true;
    } catch {
      // この人の画像だけ保存できなくても、残りは続ける
    }
  }

  if (changed) window.dispatchEvent(new Event(AVATAR_EVENT));
}
