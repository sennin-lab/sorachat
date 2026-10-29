import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { calls } from "./call";
import { CallOverlay } from "./CallOverlay";
import { ChatView } from "./ChatView";
import { cachedConversations, saveConversations } from "./cache";
import { ConversationList } from "./ConversationList";
import { Icon } from "./Icon";
import { NewChatSheet } from "./NewChatSheet";
import { connectRealtime, onDataEvent, startDataSync } from "./realtime";
import { ProfileSheet } from "./ProfileSheet";
import { refreshPushSubscription } from "./push";
import type { Conversation, Me } from "./types";

export function Home({ me, onMeChange, onLogout }: { me: Me; onMeChange: (me: Me) => void; onLogout: () => void }) {
  const [list, setList] = useState<Conversation[]>(cachedConversations);
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("dm"));
  const [showProfile, setShowProfile] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("sorachat-theme") === "dark" ? "dark" : "light"
  );
  const timer = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sorachat-theme", theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    let next: Conversation[];
    try {
      next = await api<Conversation[]>("/api/dm/conversations");
    } catch {
      return;
    }
    // 相手のノートを一緒に取得し、DM一覧の吹き出しに使う（取得に失敗しても一覧は表示する）
    const ids = next.filter((c) => !c.isGroup && c.otherId).map((c) => c.otherId!);
    const notes = ids.length
      ? await api<Record<string, string>>(`/api/dm/notes?ids=${ids.join(",")}`).catch(() => ({} as Record<string, string>))
      : {};
    const withNotes = next.map((c) => ({ ...c, note: c.otherId ? notes[c.otherId] ?? null : null }));
    setList(withNotes);
    saveConversations(withNotes);
  }, []);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(refresh, 400);
  }, [refresh]);

  useEffect(() => {
    refresh();
    connectRealtime();
    if (me.notifyDm) refreshPushSubscription();
    startDataSync(me.id).catch(() => undefined);
    calls.init({ id: me.id, name: me.displayName, hasAvatar: me.hasAvatar }).catch(() => undefined);
    const off = onDataEvent((event) => {
      if (event.kind === "change") scheduleRefresh();
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

  return (
    <div className={`app ${selectedId ? "has-chat" : ""}`}>
      <aside className="sidebar">
        <header className="inbox-head">
          <button className="avatar-btn" onClick={() => setShowProfile(true)} aria-label="プロフィール">
            <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={me.displayName} size={30} />
          </button>
          <strong>{me.username}</strong>
          <button className="icon-btn" onClick={() => setShowNew(true)} aria-label="新規メッセージ">
            <Icon name="compose" size={24} />
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
            conversation={list.find((c) => c.id === selectedId) ?? null}
            conversations={list}
            onBack={() => setSelectedId(null)}
            onActivity={scheduleRefresh}
          />
        ) : (
          <div className="empty">
            <Icon name="chat" size={96} className="empty-icon" />
            <p className="empty-title">メッセージを送信しよう</p>
            <p className="muted">友達とのトークを選ぶか、新規メッセージを作成します。</p>
            <button className="btn-primary" onClick={() => setShowNew(true)}>
              新規メッセージ
            </button>
          </div>
        )}
      </main>

      {showProfile && (
        <ProfileSheet
          me={me}
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setShowProfile(false)}
          onChange={onMeChange}
          onLogout={onLogout}
        />
      )}
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
