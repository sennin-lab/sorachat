import type { Conversation, Message } from "./types";
import { idbClear, idbGet, idbPut } from "./idb";

// 保存先は2つ：
// ・localStorage … 画面を開いた瞬間に使う（同期で読める・件数は少なめ）
// ・IndexedDB     … 容量が大きく、より多くのメッセージを保存する（非公開ブラウズでは使わない）
const LIST_KEY = "sorachat.conversations";
const messageKey = (id: string) => `sorachat.messages.${id}`;
const LOCAL_MESSAGE_LIMIT = 50;
const DB_MESSAGE_LIMIT = 200;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

export const cachedConversations = (): Conversation[] => read<Conversation[]>(LIST_KEY) ?? [];

export const saveConversations = (list: Conversation[]) => {
  write(LIST_KEY, list);
  void idbPut("kv", LIST_KEY, list);
};

// IndexedDB から会話一覧を読む（localStorage が空・容量超過のときの予備）
export const loadConversationsDb = async (): Promise<Conversation[]> =>
  (await idbGet<Conversation[]>("kv", LIST_KEY)) ?? [];

export const cachedMessages = (id: string): Message[] => read<Message[]>(messageKey(id)) ?? [];

// IndexedDB から、そのトークのメッセージを読む
export const loadMessagesDb = async (id: string): Promise<Message[]> =>
  (await idbGet<Message[]>("kv", messageKey(id))) ?? [];

export const saveMessages = (id: string, list: Message[]) => {
  write(messageKey(id), list.slice(-LOCAL_MESSAGE_LIMIT));
  void idbPut("kv", messageKey(id), list.slice(-DB_MESSAGE_LIMIT));
};

export function clearCache() {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("sorachat."))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage が使えなくても、IndexedDB の掃除は続ける
  }
  void idbClear("kv");
  void idbClear("avatars");
}
