import type { Friend } from "./types";
import { idbDelete, idbGet, idbKeys, idbPut, isPrivateBrowsing } from "./idb";

// 友だちの一覧と、そのプロフィール画像を保存する。
// ・localStorage … データURLで保存（同期で読めるので、最初の描画がすぐ出る）
// ・IndexedDB     … Blob で保存（容量が大きい画像も入る・表示はオブジェクトURLで出す）
// 非公開ブラウズ中は、画像をまとめて取りに行かない（表示するときに1枚ずつ読む）。
const FRIENDS_KEY = "sorachat.friends";
const avatarKey = (userId: string) => `sorachat.avatar.${userId}`;
const AVATAR_EVENT = "sorachat:avatars";
// localStorage に入れる1枚の上限（バイト）。localStorage の容量（約5MB）を圧迫しないため
const MAX_AVATAR_BYTES = 120_000;
// IndexedDB に入れる1枚の上限（バイト）
const MAX_DB_AVATAR_BYTES = 1_000_000;

type StoredAvatar = { v: string; d: string };
type AvatarRecord = { v: string; blob: Blob };

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

// 画面に表示するためのオブジェクトURL（IndexedDB の画像から作る）
const blobUrls = new Map<string, string>();

const forgetBlobUrl = (userId: string) => {
  const url = blobUrls.get(userId);
  if (url) URL.revokeObjectURL(url);
  blobUrls.delete(userId);
};

export async function avatarObjectUrl(userId: string): Promise<string | null> {
  const known = blobUrls.get(userId);
  if (known) return known;
  const record = await idbGet<AvatarRecord>("avatars", userId);
  if (!record?.blob) return null;
  // 読んでいる間に別の経路で作られていたら、そちらを使う
  const again = blobUrls.get(userId);
  if (again) return again;
  const url = URL.createObjectURL(record.blob);
  blobUrls.set(userId, url);
  return url;
}

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

// 友だちの画像を保存する。版が同じなら取りに行かない。
// 友だちでなくなった人の保存分は消す。
export async function syncFriendAvatars(friends: Friend[]): Promise<void> {
  // 非公開ブラウズ中は画像をまとめて保存・取得しない（データベースの転送量を抑える）
  if (await isPrivateBrowsing()) return;

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
    for (const id of await idbKeys("avatars")) {
      if (!keep.has(id)) {
        await idbDelete("avatars", id);
        forgetBlobUrl(id);
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
        if (await idbGet("avatars", friend.id)) {
          await idbDelete("avatars", friend.id);
          forgetBlobUrl(friend.id);
          changed = true;
        }
        continue;
      }

      const version = friend.avatarVersion ?? "";
      const stored = await idbGet<AvatarRecord>("avatars", friend.id);
      const dbOk = stored?.v === version;
      const localOk = readAvatar(friend.id)?.v === version;
      if (dbOk && localOk) continue;

      // 画像が変わったときだけ取りに行く（IndexedDB にある画像は再利用する）
      let blob: Blob | null = dbOk && stored ? stored.blob : null;
      if (!blob) {
        const res = await fetch(`/api/users/${friend.id}/avatar`, { credentials: "same-origin" });
        if (!res.ok) continue;
        blob = await res.blob();
        if (blob.size <= MAX_DB_AVATAR_BYTES) {
          await idbPut("avatars", friend.id, { v: version, blob } satisfies AvatarRecord);
          forgetBlobUrl(friend.id);
          changed = true;
        }
      }

      if (!localOk && blob.size <= MAX_AVATAR_BYTES) {
        const data = await toDataUrl(blob);
        localStorage.setItem(avatarKey(friend.id), JSON.stringify({ v: version, d: data } satisfies StoredAvatar));
        changed = true;
      }
    } catch {
      // この人の画像だけ保存できなくても、残りは続ける
    }
  }

  if (changed) window.dispatchEvent(new Event(AVATAR_EVENT));
}
