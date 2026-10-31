import { useCallback, useEffect, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { api, post } from "./api";
import { ChatView } from "./ChatView";
import { cachedConversations, saveConversations } from "./cache";
import { ConversationList } from "./ConversationList";
import { connectRealtime, onDataEvent, startDataSync } from "./realtime";
import { refreshPush } from "./push";
import { NotifyPrompt } from "./NotifyPrompt";
import { OpenChatSheet } from "./OpenChatSheet";
import { AddFriendSheet } from "./AddFriendSheet";
import { FriendsTab } from "./FriendsTab";
import { Icon } from "./Icon";
import { NewChatSheet } from "./NewChatSheet";
import { ProfileSheet } from "./ProfileSheet";
import { SettingsSheet } from "./SettingsSheet";
import { UserProfileSheet } from "./UserProfileSheet";
import { Avatar } from "./Avatar";
import type { Conversation, Friend, Me } from "./types";
import { saveFriends, syncFriendAvatars } from "./avatarCache";

type Tab = "talk" | "friends" | "more";

// 「あとで」を押したら、この日数のあいだは通知の確認を出さない
const NOTIFY_LATER_KEY = "sorachat-notify-later";
const NOTIFY_LATER_DAYS = 3;

// 通知がオフ（または許可されていない）ときだけ確認を出す。通知に対応していない環境では出さない
const shouldAskNotify = (me: Me) => {
  if (!("Notification" in window) || !("PushManager" in window)) return false;
  if (me.notifyDm && Notification.permission === "granted") return false;
  try {
    const last = Number(localStorage.getItem(NOTIFY_LATER_KEY));
    if (last && Date.now() - last < NOTIFY_LATER_DAYS * 24 * 60 * 60 * 1000) return false;
  } catch {
    return true;
  }
  return true;
};

// URL とタブの対応。プロフィールなどの重ねて表示する画面では null（直前のタブを保つ）
const tabOfPath = (path: string): Tab | null => {
  if (path.startsWith("/friends")) return "friends";
  if (path.startsWith("/more")) return "more";
  if (path === "/" || path.startsWith("/home") || path.startsWith("/dm/") || path.startsWith("/groupchat/")) return "talk";
  return null;
};

const TAB_PATH: Record<Tab, string> = { talk: "/home", friends: "/friends", more: "/more" };

const TABS: { id: Tab; label: string; icon: "chat" | "users" | "menu" }[] = [
  { id: "talk", label: "トーク", icon: "chat" },
  { id: "friends", label: "友だち", icon: "users" },
  { id: "more", label: "その他", icon: "menu" }
];

export function Home({ me, onMeChange, onLogout }: { me: Me; onMeChange: (me: Me) => void; onLogout: () => void }) {
  const [list, setList] = useState<Conversation[]>(cachedConversations);
  // 画面の状態は URL から決める（/home, /friends, /more, /dm/:id, /groupchat/:id, /profile/:id）
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname;
  const chatId = (matchPath("/dm/:id", path) ?? matchPath("/groupchat/:id", path))?.params.id ?? null;
  const viewUser = matchPath("/profile/:id", path)?.params.id ?? null;

  const [selectedId, setSelectedId] = useState<string | null>(chatId);
  const [tab, setTab] = useState<Tab>(() => tabOfPath(path) ?? "talk");
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showOpenChats, setShowOpenChats] = useState(false);
  const [showNotifyPrompt, setShowNotifyPrompt] = useState(() => shouldAskNotify(me));
  const [showAdd, setShowAdd] = useState(false);
  // 友だちが増えた・減ったときに友だち一覧を取り直すための番号
  const [friendsVersion, setFriendsVersion] = useState(0);
  const bumpFriends = () => setFriendsVersion((v) => v + 1);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("sorachat-theme") === "dark" ? "dark" : "light"
  );
  const timer = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sorachat-theme", theme);
  }, [theme]);

  // URL に合わせてタブと選択中のトークを更新する
  useEffect(() => {
    const next = tabOfPath(path);
    if (next) setTab(next);
    if (chatId) setSelectedId(chatId);
    else if (path === "/home") setSelectedId(null);
  }, [path, chatId]);

  // 「/」は /home へ。通知の旧リンク（/?dm=ID）は /dm/ID へ移す
  useEffect(() => {
    if (path !== "/") return;
    const legacy = new URLSearchParams(location.search).get("dm");
    navigate(legacy ? `/dm/${legacy}` : "/home", { replace: true });
  }, []);

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

  // 通知を許可済みなら、起動のたびに購読を確かめ直す（端末側の購読が切れていても届くように）
  useEffect(() => {
    if (me.notifyDm) void refreshPush();
  }, [me.id, me.notifyDm]);

  useEffect(() => {
    refresh();
    connectRealtime();
    startDataSync(me.id).catch(() => undefined);
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

  // トークを開く（URL も切り替える。プロフィールから開いたときは履歴に残さず置き換える）
  // 友だちの一覧と画像を先に保存しておく（トーク一覧や新規作成でも、すぐ画像を出せるように）
  useEffect(() => {
    api<Friend[]>("/api/friends")
      .then((next) => {
        saveFriends(next);
        void syncFriendAvatars(next);
      })
      .catch(() => undefined);
  }, [me.id, friendsVersion]);

  const select = (id: string, options?: { replace?: boolean }) => {
    const isGroup = list.find((c) => c.id === id)?.isGroup ?? false;
    setSelectedId(id);
    setList((current) => current.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    navigate(`/${isGroup ? "groupchat" : "dm"}/${id}`, { replace: options?.replace ?? false });
  };

  // プロフィールを閉じる（開いた元の画面へ戻る）
  const closeProfile = () => {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate(TAB_PATH[tab], { replace: true });
  };

  // 名前（ユーザー名）からトークを開く。友だちの画面から「トーク」を押したとき
  // 成功したら true を返す（失敗時は呼び出し側で案内を出せるようにする）
  const openDmWith = async (username: string): Promise<boolean> => {
    try {
      const result = await api<{ id: string }>("/api/dm/open", post({ username }));
      setShowAdd(false);
      setTab("talk");
      select(result.id, { replace: Boolean(viewUser) });
      refresh();
      return true;
    } catch {
      return false;
    }
  };

  // タブを押したら、スマホではトークを閉じて選んだタブの画面に戻る（PCは会話を開いたままにする）
  const pickTab = (next: Tab) => {
    setTab(next);
    if (selectedId && window.matchMedia("(max-width: 759px)").matches) setSelectedId(null);
    navigate(TAB_PATH[next]);
  };

  const totalUnread = list.reduce((sum, c) => sum + c.unread, 0);

  return (
    <div className={`app ${selectedId ? "has-chat" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-body" key={tab}>
          {tab === "talk" && (
            <ConversationList list={list} selectedId={selectedId} onSelect={select} onCompose={() => setShowNew(true)} />
          )}
          {tab === "friends" && (
            <FriendsTab
              me={me}
              onOpenMe={() => setShowProfile(true)}
              onOpenUser={(id) => navigate(`/profile/${id}`)}
              version={friendsVersion}
              onAdd={() => setShowAdd(true)}
            />
          )}
          {tab === "more" && (
            <div className="tab-panel" key="more">
              <header className="tab-head">
                <strong className="tab-title">その他</strong>
                <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="設定">
                  <Icon name="settings" size={23} />
                </button>
              </header>
              <button className="profile-card" onClick={() => setShowProfile(true)}>
                <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={me.displayName} size={64} />
                <span className="row-text">
                  <strong>{me.displayName}</strong>
                  <small>{me.bio || "ステータスメッセージを設定しよう"}</small>
                </span>
                <Icon name="chevron" size={18} className="chev" />
              </button>
              <ul className="more-list">
                <li>
                  <button onClick={() => setShowProfile(true)}>
                    <span className="option-icon">
                      <Icon name="user" size={20} />
                    </span>
                    プロフィール
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => setShowOpenChats(true)}>
                    <span className="option-icon">
                      <Icon name="users" size={20} />
                    </span>
                    オープンチャット
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => setShowSettings(true)}>
                    <span className="option-icon">
                      <Icon name="settings" size={20} />
                    </span>
                    設定
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
              </ul>
            </div>
          )}
        </div>

        <nav className="tabbar" aria-label="メニュー">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab-btn ${tab === t.id ? "on" : ""}`}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => pickTab(t.id)}
            >
              <span className="tab-icon">
                <Icon name={t.icon} size={24} />
                {t.id === "talk" && totalUnread > 0 && (
                  <span className="tab-badge" key={totalUnread}>
                    {totalUnread > 99 ? "99+" : totalUnread}
                  </span>
                )}
              </span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="chat-pane">
        {selectedId ? (
          <ChatView
            key={selectedId}
            conversationId={selectedId}
            meId={me.id}
            conversation={list.find((c) => c.id === selectedId) ?? null}
            conversations={list}
            onBack={() => {
              setSelectedId(null);
              navigate("/home");
            }}
            onActivity={scheduleRefresh}
          />
        ) : (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">
              <Icon name="chat" size={56} />
            </div>
            <p className="empty-title">トークを選んでください</p>
            <p className="muted">友だちとのトークを選ぶか、新規トークを始めましょう。</p>
            <button className="btn-primary" onClick={() => setShowNew(true)}>
              新規トーク
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
      {showSettings && (
        <SettingsSheet
          me={me}
          theme={theme}
          onThemeChange={setTheme}
          onChange={onMeChange}
          onClose={() => setShowSettings(false)}
          onLogout={onLogout}
        />
      )}
      {showNew && (
        <NewChatSheet
          onClose={() => setShowNew(false)}
          onOpen={(id) => {
            setShowNew(false);
            setTab("talk");
            select(id);
            refresh();
          }}
        />
      )}
      {showAdd && (
        <AddFriendSheet
          onClose={() => setShowAdd(false)}
          onAdded={bumpFriends}
          onOpenDm={(username) => openDmWith(username)}
        />
      )}
      {viewUser && (
        <UserProfileSheet
          userId={viewUser}
          onClose={closeProfile}
          onMessage={(username) => void openDmWith(username)}
          onFriendsChanged={bumpFriends}
        />
      )}
      {showOpenChats && (
        <OpenChatSheet
          onClose={() => setShowOpenChats(false)}
          onOpen={(id) => {
            setShowOpenChats(false);
            setTab("talk");
            select(id);
            refresh();
          }}
        />
      )}
      {showNotifyPrompt && (
        <NotifyPrompt
          onEnabled={(next) => {
            onMeChange(next);
            setShowNotifyPrompt(false);
          }}
          onLater={() => {
            try {
              localStorage.setItem(NOTIFY_LATER_KEY, String(Date.now()));
            } catch {
              // 保存できなくても、この画面では閉じる
            }
            setShowNotifyPrompt(false);
          }}
        />
      )}
    </div>
  );
}
