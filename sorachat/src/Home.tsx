import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { calls } from "./call";
import { CallOverlay } from "./CallOverlay";
import { ChatView } from "./ChatView";
import { cachedConversations, saveConversations } from "./cache";
import { ConversationList } from "./ConversationList";
import { NewChatSheet } from "./NewChatSheet";
import { onDataEvent, startDataSync } from "./realtime";
import { ProfileSheet } from "./ProfileSheet";
import { SettingsSheet } from "./SettingsSheet";
import type { Conversation, Me } from "./types";

export function Home({ me, onMeChange, onLogout }: { me: Me; onMeChange: (me: Me) => void; onLogout: () => void }) {
  const [list, setList] = useState<Conversation[]>(cachedConversations);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("dm"));
  const [showProfile, setShowProfile] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("sorachat-theme") === "dark" ? "dark" : "light"));
  const timer = useRef(0);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("sorachat-theme", theme); }, [theme]);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Conversation[]>("/api/dm/conversations");
      setList(next);
      saveConversations(next);
    } catch {
      return;
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(refresh, 400);
  }, [refresh]);

  useEffect(() => {
    refresh();
    startDataSync(me.id).catch(() => undefined);
    calls.init({ id: me.id, name: me.displayName, hasAvatar: me.hasAvatar }).catch(() => undefined);
    const off = onDataEvent((event) => {
      if (event.kind !== "reaction") scheduleRefresh();
    });
    const fallback = window.setInterval(refresh, 120_000);
    return () => {
      off();
      window.clearInterval(fallback);
      window.clearTimeout(timer.current);
    };
  }, [me.id]);

  const select = (id: string) => {
    setSelectedId(id);
    setList((current) => current.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  };

  const selected = list.find((c) => c.id === selectedId) ?? null;

  return (
    <div className={`app ${selectedId ? "has-chat" : ""}`}>
      <aside className="sidebar">
        <header className="sidebar-head">
          <button className="avatar-btn" onClick={() => setShowProfile(true)} aria-label="プロフィール">
            <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={me.displayName} size={36} />
          </button>
          <h1>SoraChat</h1>
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="設定" title="設定">
            <i className="fa-solid fa-gear" />
          </button>
          <button className="icon-btn primary-icon" onClick={() => setShowNew(true)} aria-label="新しいトーク" title="新しいトーク">
            <i className="fa-solid fa-pen-to-square" />
          </button>
        </header>
        <ConversationList list={list} selectedId={selectedId} onSelect={select} />
      </aside>

      <main className="chat-pane">
        {selectedId ? (
          <ChatView
            key={selectedId}
            conversationId={selectedId}
            meId={me.id}
            conversation={selected}
            onBack={() => setSelectedId(null)}
            onActivity={scheduleRefresh}
          />
        ) : (
          <div className="empty">会話を選ぶか、＋から新しいトークを始めましょう。</div>
        )}
      </main>

      {showProfile && (
        <ProfileSheet me={me} onClose={() => setShowProfile(false)} onChange={onMeChange} onLogout={onLogout} />
      )}
      {showSettings && <SettingsSheet theme={theme} onThemeChange={setTheme} onClose={() => setShowSettings(false)} />}
      {showNew && (
        <NewChatSheet
          onClose={() => setShowNew(false)}
          onOpen={(id) => {
            setShowNew(false);
            select(id);
            refresh();
          }}
        />
      )}
      <CallOverlay />
    </div>
  );
}
