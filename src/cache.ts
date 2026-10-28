import type { Conversation, Message } from "./types";

const LIST_KEY = "sorachat.conversations";
const messageKey = (id: string) => `sorachat.messages.${id}`;

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
export const saveConversations = (list: Conversation[]) => write(LIST_KEY, list);
export const cachedMessages = (id: string): Message[] => read<Message[]>(messageKey(id)) ?? [];
export const saveMessages = (id: string, list: Message[]) => write(messageKey(id), list.slice(-50));

export function clearCache() {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("sorachat."))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    return;
  }
}
