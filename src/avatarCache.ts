import type { Friend } from "./types";
import { idbDelete, idbGet, idbPut, isPrivateBrowsing } from "./idb";

// プロフィール画像（自分・友だち・グループのメンバー）を保存する。
// 画像ごとに「版（avatarVersion）」を持ち、版が同じなら保存済みの画像をそのまま使う（サーバーにも取りに行かない）。
// ・localStorage … 友だち・自分の画像をデータURLで保存（同期で読めるので、最初の描画がすぐ出る）
// ・IndexedDB     … すべての人の画像を Blob で保存（グループの送信者の画像もここから出す）
// 非公開ブラウズ中は、画像をまとめて取りに行かない（表示するときに1枚ずつ読む）。
const FRIENDS_KEY = "sorachat.friends";
const avatarKey = (userId: string) => `sorachat.avatar.${userId}`;
const AVATAR_EVENT = "sorachat:avatars";
// localStorage に入れる1枚の上限（バイト）。localStorage の容量（約5MB）を圧迫しないため
const MAX_AVATAR_BYTES = 120_000;
// IndexedDB に入れる1枚の上限（バイト）
const MAX_DB_AVATAR_BYTES = 1_000_000;

export type AvatarPerson = { id: string; hasAvatar: boolean; avatarVersion?: string | null };

type StoredAvatar = { v: string; d: string };
type AvatarRecord = { v: string; blob: Blob };

// 画面が知っている、人ごとの最新の版（サーバーから受け取った値）
const knownVersions = new Map<string, string | null>();

// 人の画像の版を覚える。覚えた版と違う保存分は使わない
export function rememberAvatars(people: AvatarPerson[]) {
  for (const p of people) {
    if (p.avatarVersion === undefined) continue;
    knownVersions.set(p.id, p.avatarVersion);
  }
}

// 覚えている版と保存分が合うか（版を知らないときは、保存分をそのまま使う）
const matches = (userId: string, stored: string) => {
  const known = knownVersions.get(userId);
  return known === undefined || (known ?? "") === stored;
};

// 画面が知っている画像の版（画像のURLに付けて、ブラウザの保存を使えるようにする）
export const knownAvatarVersion = (userId: string): string | null => knownVersions.get(userId) ?? null;

const readAvatar = (userId: string): StoredAvatar | null => {
  try {
    const raw = localStorage.getItem(avatarKey(userId));
    return raw ? (JSON.parse(raw) as StoredAvatar) : null;
  } catch {
    return null;
  }
};

// 保存済みの画像（データURL）。なければ null
export const cachedAvatar = (userId: string): string | null => {
  const record = readAvatar(userId);
  if (!record || !matches(userId, record.v)) return null;
  return record.d;
};

// 画面に表示するためのオブジェクトURL（IndexedDB の画像から作る）
const blobUrls = new Map<string, { version: string; url: string }>();

// 古いオブジェクトURLは、すぐには無効にしない（表示中の画像が、差し替えの途中で壊れて見えないように）
const forgetBlobUrl = (userId: string) => {
  const entry = blobUrls.get(userId);
  if (entry) window.setTimeout(() => URL.revokeObjectURL(entry.url), 60_000);
  blobUrls.delete(userId);
};

export async function avatarObjectUrl(userId: string): Promise<string | null> {
  const known = blobUrls.get(userId);
  if (known && matches(userId, known.version)) return known.url;
  const record = await idbGet<AvatarRecord>("avatars", userId);
  if (!record?.blob || !matches(userId, record.v)) return null;
  // 読んでいる間に別の経路で作られていたら、そちらを使う
  const again = blobUrls.get(userId);
  if (again && matches(userId, again.version)) return again.url;
  forgetBlobUrl(userId);
  const url = URL.createObjectURL(record.blob);
  blobUrls.set(userId, { version: record.v, url });
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

// 人の画像を保存する。版が同じなら取りに行かない（サーバーにもDBにも問い合わせない）。
// local が true のときは localStorage にも置く（自分と友だち）。
// 友だちの一覧にない人の localStorage の分は消す（local のときだけ）。
// 画像が保存されたことを、まとめて1回だけ画面に知らせる（人数が多くても、画面の更新を何度も走らせない）
let notifyTimer: number | undefined;
const notifySoon = () => {
  window.clearTimeout(notifyTimer);
  notifyTimer = window.setTimeout(() => window.dispatchEvent(new Event(AVATAR_EVENT)), 120);
};

// 取れなかった人の画像は、少し待って取り直す（通信の一時的な失敗で、リロードするまで出ないことがないように）
const RETRY_SYNC_MS = [8_000, 30_000, 90_000];

export async function syncAvatars(
  people: AvatarPerson[],
  options: { local?: boolean; attempt?: number } = {}
): Promise<void> {
  rememberAvatars(people);
  // 非公開ブラウズ中は画像をまとめて保存・取得しない（データベースの転送量を抑える）
  if (await isPrivateBrowsing()) return;

  let changed = false;
  const failed: AvatarPerson[] = [];
  const attempt = options.attempt ?? 0;
  const local = Boolean(options.local);
  // 取り直しのときは、一覧にない人の保存分を消さない（一部の人だけを渡しているため）
  if (local && attempt === 0) {
    try {
      const keep = new Set(people.map((p) => p.id));
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
  }

  for (const person of people) {
    try {
      if (!person.hasAvatar) {
        if (readAvatar(person.id)) {
          localStorage.removeItem(avatarKey(person.id));
          changed = true;
        }
        if (await idbGet("avatars", person.id)) {
          await idbDelete("avatars", person.id);
          forgetBlobUrl(person.id);
          changed = true;
        }
        continue;
      }

      const version = person.avatarVersion ?? "";
      const stored = await idbGet<AvatarRecord>("avatars", person.id);
      const dbOk = stored?.v === version;
      const localOk = !local || readAvatar(person.id)?.v === version;
      if (dbOk && localOk) continue;

      // 画像が変わったときだけ取りに行く（IndexedDB にある画像は再利用する）
      let blob: Blob | null = dbOk && stored ? stored.blob : null;
      if (!blob) {
        const res = await fetch(`/api/users/${person.id}/avatar${version ? `?v=${encodeURIComponent(version)}` : ""}`, {
          credentials: "same-origin"
        });
        if (!res.ok) {
          failed.push(person);
          continue;
        }
        blob = await res.blob();
        if (blob.size <= MAX_DB_AVATAR_BYTES) {
          await idbPut("avatars", person.id, { v: version, blob } satisfies AvatarRecord);
          forgetBlobUrl(person.id);
          changed = true;
        }
      }

      if (local && !localOk && blob.size <= MAX_AVATAR_BYTES) {
        const data = await toDataUrl(blob);
        localStorage.setItem(avatarKey(person.id), JSON.stringify({ v: version, d: data } satisfies StoredAvatar));
        changed = true;
      }
    } catch {
      // この人の画像だけ保存できなくても、残りは続ける
      failed.push(person);
    }
    // 1人ずつ保存できたら、すぐ画面に知らせる（全員ぶんが終わるのを待たない）
    if (changed) notifySoon();
  }

  if (changed) notifySoon();
  if (failed.length > 0 && attempt < RETRY_SYNC_MS.length) {
    window.setTimeout(() => void syncAvatars(failed, { local: options.local, attempt: attempt + 1 }), RETRY_SYNC_MS[attempt]);
  }
}
