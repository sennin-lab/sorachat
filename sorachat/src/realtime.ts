import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { api } from "./api";

type TokenInfo = { token: string; url: string; anonKey: string; expiresAt: number };

let tokenInfo: TokenInfo | null = null;
let clientPromise: Promise<SupabaseClient> | null = null;
let dataChannel: RealtimeChannel | null = null;

async function fetchToken(): Promise<TokenInfo> {
  const data = await api<{ token: string; url: string; anonKey: string; expiresIn: number }>("/api/realtime/token");
  tokenInfo = { token: data.token, url: data.url, anonKey: data.anonKey, expiresAt: Date.now() + data.expiresIn * 1000 };
  return tokenInfo;
}

export function getClient(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = fetchToken().then(
      (info) =>
        createClient(info.url, info.anonKey, {
          accessToken: async () => {
            if (!tokenInfo || tokenInfo.expiresAt - Date.now() < 60_000) await fetchToken();
            return tokenInfo!.token;
          },
          auth: { persistSession: false, autoRefreshToken: false }
        })
    );
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

export type DataEvent =
  | { kind: "message"; row: Record<string, any> }
  | { kind: "reaction"; row: Record<string, any>; deleted: boolean }
  | { kind: "change" };

const listeners = new Set<(event: DataEvent) => void>();

export function onDataEvent(listener: (event: DataEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const emit = (event: DataEvent) => listeners.forEach((listener) => listener(event));

export async function startDataSync(userId: string) {
  if (dataChannel) return;
  const client = await getClient();
  dataChannel = client
    .channel(`data:${userId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "sc_messages" }, (p) =>
      emit({ kind: "message", row: p.new })
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "sc_reactions" }, (p) =>
      emit({ kind: "reaction", row: (p.eventType === "DELETE" ? p.old : p.new) as Record<string, any>, deleted: p.eventType === "DELETE" })
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "sc_members" }, () => emit({ kind: "change" }))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "sc_conversations" }, () => emit({ kind: "change" }))
    .on("postgres_changes", { event: "*", schema: "public", table: "sc_notes" }, () => emit({ kind: "change" }))
    .subscribe();
}
