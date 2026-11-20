import type { Conversation, Me, Message } from "./types";
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

// 自分の情報（名前・アイコンの版など）。IndexedDB に保存して、次に開くとき先に表示する
const ME_KEY = "sorachat.me";
export const loadMeDb = async (): Promise<Me | null> => (await idbGet<Me>("kv", ME_KEY)) ?? null;
export const saveMeDb = (me: Me) => {
  void idbPut("kv", ME_KEY, me);
};

// グループの送信者（名前・アイコン）。送った人が今のメンバーでなくても名前を出せるように、残しておく
export type PersonInfo = { name: string; hasAvatar: boolean; avatarVersion?: string | null };
const peopleKey = (conversationId: string) => `sorachat.people.${conversationId}`;
export const loadPeopleDb = async (conversationId: string): Promise<Record<string, PersonInfo>> =>
  (await idbGet<Record<string, PersonInfo>>("kv", peopleKey(conversationId))) ?? {};
export const savePeopleDb = (conversationId: string, people: Record<string, PersonInfo>) => {
  void idbPut("kv", peopleKey(conversationId), people);
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
