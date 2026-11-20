// IndexedDB の小さなラッパー。
// トークの一覧・メッセージ・プロフィール画像を保存して、次に開くときの表示を速くする。
// 非公開ブラウズ（プライベートモード）では保存しない（閉じると消えるため、通信量だけ増えてしまう）。

const DB_NAME = "sorachat";
const DB_VERSION = 1;

export type StoreName = "kv" | "avatars";

let dbPromise: Promise<IDBDatabase> | null = null;
let privatePromise: Promise<boolean> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!("indexedDB" in self)) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("avatars")) db.createObjectStore("avatars");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
};

// 非公開ブラウズかどうか（一度調べたら結果を使い回す）
// ・IndexedDB を開けない（古い Firefox / Safari の非公開モード）
// ・保存領域の上限が極端に小さい（Chrome のシークレットモードは約120MB）
export const isPrivateBrowsing = (): Promise<boolean> => {
  if (!privatePromise) {
    privatePromise = (async () => {
      try {
        await openDb();
      } catch {
        return true;
      }
      try {
        const estimate = await navigator.storage?.estimate();
        if (estimate?.quota && estimate.quota < 120 * 1024 * 1024) return true;
      } catch {
        return false;
      }
      return false;
    })();
  }
  return privatePromise;
};

const run = async <T>(
  store: StoreName,
  mode: IDBTransactionMode,
  action: (os: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

// 非公開ブラウズ中・エラー時は何もしない（表示は通常どおりデータベースから読む）
export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  if (await isPrivateBrowsing()) return undefined;
  try {
    return (await run<T | undefined>(store, "readonly", (os) => os.get(key))) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  if (await isPrivateBrowsing()) return;
  try {
    await run(store, "readwrite", (os) => os.put(value, key));
  } catch {
    // 保存できなくても表示は続ける
  }
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  if (await isPrivateBrowsing()) return;
  try {
    await run(store, "readwrite", (os) => os.delete(key));
  } catch {
    return;
  }
}

export async function idbKeys(store: StoreName): Promise<string[]> {
  if (await isPrivateBrowsing()) return [];
  try {
    const keys = await run<IDBValidKey[]>(store, "readonly", (os) => os.getAllKeys());
    return keys.map(String);
  } catch {
    return [];
  }
}

export async function idbClear(store: StoreName): Promise<void> {
  try {
    await run(store, "readwrite", (os) => os.clear());
  } catch {
    return;
  }
}
