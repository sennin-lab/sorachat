import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { api, post } from "./api";
import { ChatView } from "./ChatView";
import { cachedConversations, loadConversationsDb, saveConversations } from "./cache";
import { prefetchMessages } from "./prefetch";
import { ConversationList } from "./ConversationList";
import { connectRealtime, onDataEvent, startDataSync } from "./realtime";
import { refreshPush } from "./push";
import { NotifyPrompt } from "./NotifyPrompt";
import { OpenChatSheet } from "./OpenChatSheet";
import { ReferralSheet } from "./ReferralSheet";
import { StorePage } from "./StorePage";
import { StudioPage } from "./StudioPage";
import { TubePage } from "./TubePage";
import { ExtensionsPage } from "./ExtensionsPage";
import { ChatBootScreen } from "./Loading";
// SenninPay は使うときだけ読み込む（通常の起動を軽く保つため）
const SenninPayPage = lazy(() => import("./SenninPayPage").then((m) => ({ default: m.SenninPayPage })));
// senningames（1人で遊ぶゲーム）も、開くときだけ読み込む
const SenningamesPage = lazy(() => import("./SenningamesPage").then((m) => ({ default: m.SenningamesPage })));
// SenninBank（銀行）も、開くときだけ読み込む
const BankPage = lazy(() => import("./BankPage").then((m) => ({ default: m.BankPage })));
import { AddFriendSheet } from "./AddFriendSheet";
import { FriendsTab } from "./FriendsTab";
import { Icon } from "./Icon";
import { NewChatSheet } from "./NewChatSheet";
import { ProfileSheet } from "./ProfileSheet";
import { ExitMotion } from "./ExitMotion";
import { SettingsSheet } from "./SettingsSheet";
import { UserProfileSheet } from "./UserProfileSheet";
import { Avatar } from "./Avatar";
import { SENNIN_BOT_ID } from "./robot";
import type { Conversation, Friend, Me } from "./types";
import { saveFriends, syncAvatars } from "./avatarCache";

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
  if (path.startsWith("/more") || path.startsWith("/store") || path.startsWith("/studio") || path.startsWith("/pay") || path.startsWith("/tube") || path.startsWith("/extensions") || path.startsWith("/bank")) return "more";
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
  // 一覧を取り終えたか・メッセージを先読み中のトーク（読み込み表示に使う）
  const [listLoaded, setListLoaded] = useState(false);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  // 画面の状態は URL から決める（/home, /friends, /more, /dm/:id, /groupchat/:id, /profile/:id）
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname;
  const chatId = (matchPath("/dm/:id", path) ?? matchPath("/groupchat/:id", path))?.params.id ?? null;
  const viewUser = matchPath("/profile/:id", path)?.params.id ?? null;
  // 仙人ストア（/store）と senninstudio（/studio）は、専用のページとして開く
  // （/store/item/:id・/store/author/:id、/studio/works/:id/edit のような下の画面も、同じ専用ページで開く）
  const onStorePage = path === "/store" || path.startsWith("/store/");
  const onStudioPage = path === "/studio" || path.startsWith("/studio/");
  // SenninPay（/pay）も専用のページとして開く
  const onPayPage = path === "/pay" || path.startsWith("/pay/");
  // SenninBank（/bank）も専用のページとして開く
  const onBankPage = path === "/bank" || path.startsWith("/bank/");
  // senningames（/senningames）も専用のページとして開く
  const onGamesPage = path === "/senningames" || path.startsWith("/senningames/");
  // 仙人Tube Plus（/tube）も専用のページとして開く
  const onTubePage = path === "/tube" || path.startsWith("/tube/");
  // 拡張機能（その他 →「拡張機能」）も専用のページとして開く（/extensions）
  const onExtensionsPage = path === "/extensions" || path.startsWith("/extensions/");

  const [selectedId, setSelectedId] = useState<string | null>(chatId);
  const [tab, setTab] = useState<Tab>(() => tabOfPath(path) ?? "talk");
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showOpenChats, setShowOpenChats] = useState(false);
  const [showReferral, setShowReferral] = useState(false);
  // 仙人アカウントの連携から戻ったときの結果（連携できた・できなかった）。ストアと senninstudio のページに表示する
  const [storeFlash, setStoreFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [showNotifyPrompt, setShowNotifyPrompt] = useState(() => shouldAskNotify(me));
  const [showAdd, setShowAdd] = useState(false);
  // 友だちが増えた・減ったときに友だち一覧を取り直すための番号
  const [friendsVersion, setFriendsVersion] = useState(0);
  const bumpFriends = () => setFriendsVersion((v) => v + 1);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("sorachat-theme") === "dark" ? "dark" : "light"
  );
  const timer = useRef(0);
  // チャットの画面が読み込み終わるまで、読み込み表示を出す（時間がかかりすぎたら、そのまま開く）
  const [chatReady, setChatReady] = useState(false);
  const [bootGone, setBootGone] = useState(false);
  useEffect(() => {
    if (listLoaded) setChatReady(true);
  }, [listLoaded]);
  useEffect(() => {
    const limit = window.setTimeout(() => setChatReady(true), 8000);
    return () => window.clearTimeout(limit);
  }, []);
  useEffect(() => {
    if (!chatReady) return;
    const gone = window.setTimeout(() => setBootGone(true), 350);
    return () => window.clearTimeout(gone);
  }, [chatReady]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sorachat-theme", theme);
  }, [theme]);

  // 仙人ストアで選んだ外観（吹き出し・背景の色）を、自分の画面に反映する
  // 作品の配色（色の値）は、その色を直接入れる。標準の外観は data-store-theme で決まる
  useEffect(() => {
    if (me.storeTheme) document.documentElement.dataset.storeTheme = me.storeTheme;
    else delete document.documentElement.dataset.storeTheme;
    const style = document.documentElement.style;
    const palette = me.storeThemePalette;
    if (palette) {
      style.setProperty("--mine", palette.mine);
      style.setProperty("--chat-bg", palette.bg);
      style.setProperty("--accent", palette.accent);
      style.setProperty("--accent-ink", palette.accent);
    } else {
      for (const name of ["--mine", "--chat-bg", "--accent", "--accent-ink"]) style.removeProperty(name);
    }
  }, [me.storeTheme, JSON.stringify(me.storeThemePalette ?? null)]);

  // 仙人アカウントの連携から戻ってきたら（/store か /studio に戻る）、結果を出す（URL の印は消す）
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const linked = params.get("store") === "linked";
    const error = params.get("store_error");
    if (!linked && !error) return;
    const studioPage = path.startsWith("/studio");
    const payPage = path.startsWith("/pay");
    const gamesPage = path.startsWith("/senningames");
    const bankPage = path.startsWith("/bank");
    setStoreFlash(
      linked
        ? {
            ok: true,
            text: studioPage
              ? "仙人アカウントと連携しました。作品を公開できます。"
              : payPage
                ? "仙人アカウントと連携しました。SenninPayが使えます。"
                : gamesPage
                  ? "仙人アカウントと連携しました。ポイントを出金できます。"
                  : bankPage
                    ? "仙人アカウントと連携しました。SenninBank が使えます。"
                    : "仙人アカウントと連携しました。ストアで買い物できます。"
          }
        : { ok: false, text: error ?? "" }
    );
    setTab("more");
    navigate(studioPage ? "/studio" : payPage ? "/pay" : gamesPage ? "/senningames" : bankPage ? "/bank" : "/store", { replace: true });
  }, []);

  // 専用ページを閉じる（開いた元の画面へ戻る。直接開いたときは「その他」へ）
  const closePage = () => {
    setStoreFlash(null);
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate("/more", { replace: true });
  };

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
      setListLoaded(true);
      // 未読のトークから順に、開く前のメッセージを先に保存しておく
      void prefetchMessages(next, {
        start: (id) => setLoadingIds((s) => new Set(s).add(id)),
        done: (id) =>
          setLoadingIds((s) => {
            const copy = new Set(s);
            copy.delete(id);
            return copy;
          })
      });
    } catch {
      return;
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(refresh, 400);
  }, [refresh]);

  // 保存済みの一覧が localStorage に無いときは IndexedDB から読む
  useEffect(() => {
    if (list.length) return;
    void loadConversationsDb().then((stored) => {
      if (stored.length) setList((current) => (current.length ? current : stored));
    });
  }, []);

  // AI機能の設定が変わったら一覧を取り直す
  useEffect(() => {
    void refresh();
  }, [me.aiEnabled, refresh]);

  // AI機能がオフになったら、一覧に出さないだけでなく、開いていたsenninaiのトークも閉じる
  const visibleList = list.filter((c) => me.aiEnabled || c.otherId !== SENNIN_BOT_ID);
  useEffect(() => {
    if (me.aiEnabled || !selectedId) return;
    if (list.find((c) => c.id === selectedId)?.otherId === SENNIN_BOT_ID) {
      setSelectedId(null);
      navigate("/home", { replace: true });
    }
  }, [me.aiEnabled, selectedId, list]);

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
        // 自分の画像も残すため、自分を含めて同期する（版が同じなら取りに行かない）
        void syncAvatars([{ id: me.id, hasAvatar: me.hasAvatar, avatarVersion: me.avatarVersion }, ...next], { local: true });
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
  // 連打されても1回だけ要求する（同じ相手への要求が終わるまで、次は待たせる）
  const openingDm = useRef<Promise<boolean> | null>(null);
  const openDmWith = (username: string): Promise<boolean> => {
    if (openingDm.current) return openingDm.current;
    const run = (async (): Promise<boolean> => {
      try {
        const result = await api<{ id: string }>("/api/dm/open", post({ username }));
        setShowAdd(false);
        setTab("talk");
        select(result.id, { replace: Boolean(viewUser) });
        refresh();
        return true;
      } catch {
        return false;
      } finally {
        openingDm.current = null;
      }
    })();
    openingDm.current = run;
    return run;
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
      {!bootGone && <ChatBootScreen leaving={chatReady} />}
      <aside className="sidebar">
        <div className="sidebar-body" key={tab}>
          {tab === "talk" && (
            <ConversationList
              list={visibleList}
              selectedId={selectedId}
              onSelect={select}
              onCompose={() => setShowNew(true)}
              loaded={listLoaded}
              loadingIds={loadingIds}
            />
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
                  <button onClick={() => setShowReferral(true)}>
                    <span className="option-icon">
                      <Icon name="userPlus" size={20} />
                    </span>
                    友だち招待
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => navigate("/studio")}>
                    <span className="option-icon">
                      <Icon name="edit" size={20} />
                    </span>
                    senninstudio
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => navigate("/store")}>
                    <span className="option-icon">
                      <Icon name="store" size={20} />
                    </span>
                    仙人ストア
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => navigate("/extensions")}>
                    <span className="option-icon">
                      <Icon name="code" size={20} />
                    </span>
                    拡張機能
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => navigate("/pay")}>
                    <span className="option-icon">
                      <Icon name="wallet" size={20} />
                    </span>
                    SenninPay
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => navigate("/bank")}>
                    <span className="option-icon">
                      <Icon name="bank" size={20} />
                    </span>
                    SenninBank
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => navigate("/senningames")}>
                    <span className="option-icon">
                      <Icon name="game" size={20} />
                    </span>
                    senningames
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                </li>
                <li>
                  <button onClick={() => navigate("/tube")}>
                    <span className="option-icon">
                      <Icon name="play" size={20} />
                    </span>
                    仙人Tube Plus
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

      <ExitMotion value={showProfile ? true : null}>
        {() => (
          <ProfileSheet
            me={me}
            theme={theme}
            onThemeChange={setTheme}
            onClose={() => setShowProfile(false)}
            onChange={onMeChange}
            onLogout={onLogout}
          />
        )}
      </ExitMotion>
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
          me={me}
          onClose={() => setShowAdd(false)}
          onAdded={bumpFriends}
          onOpenDm={(username) => openDmWith(username)}
        />
      )}
      <ExitMotion value={viewUser}>
        {(userId) => (
          <UserProfileSheet
            userId={userId}
            onClose={closeProfile}
            onMessage={(username) => void openDmWith(username)}
            onFriendsChanged={bumpFriends}
          />
        )}
      </ExitMotion>
      <ExitMotion value={onStudioPage ? true : null}>{() => <StudioPage flash={storeFlash} onBack={closePage} />}</ExitMotion>
      <ExitMotion value={onStorePage ? true : null}>
        {() => <StorePage me={me} flash={storeFlash} onBack={closePage} onMeChange={onMeChange} />}
      </ExitMotion>
      <ExitMotion value={onPayPage ? true : null}>
        {() => (
          <Suspense fallback={null}>
            <SenninPayPage me={me} flash={storeFlash} onBack={closePage} />
          </Suspense>
        )}
      </ExitMotion>
      <ExitMotion value={onGamesPage ? true : null}>
        {() => (
          <Suspense fallback={null}>
            <SenningamesPage flash={storeFlash} onBack={closePage} />
          </Suspense>
        )}
      </ExitMotion>
      <ExitMotion value={onBankPage ? true : null}>
        {() => (
          <Suspense fallback={null}>
            <BankPage me={me} flash={storeFlash} onBack={closePage} />
          </Suspense>
        )}
      </ExitMotion>
      <ExitMotion value={onTubePage ? true : null}>{() => <TubePage onBack={closePage} />}</ExitMotion>
      <ExitMotion value={onExtensionsPage ? true : null}>
        {() => <ExtensionsPage me={me} onBack={closePage} onMeChange={onMeChange} />}
      </ExitMotion>
      {showReferral && <ReferralSheet onClose={() => setShowReferral(false)} />}
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
