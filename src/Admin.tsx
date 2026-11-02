import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, delete_, post } from "./api";
import { Avatar } from "./Avatar";
import { formatRemaining } from "./Banned";
import { AVATAR_OPTIONS, compressImage } from "./imageCompress";
import { TEAM_ID } from "./team";
import type { BanInfo } from "./types";

// 管理者パネル（/admin/login からだけ入る。一般の画面からは入口を出さない）
type UserSummary = { id: string; username: string; displayName: string; hasAvatar: boolean; sennin: boolean; createdAt: string; ban: BanInfo | null };
type Member = { id: string; username: string; displayName: string; role: string };
type ConvSummary = {
  id: string;
  isGroup: boolean;
  isOpen: boolean;
  name: string;
  memberCount: number;
  lastMessageAt: string;
  lastPreview: string | null;
  members: Member[];
};
type UserDetail = UserSummary & {
  bio: string;
  contact: string;
  profileUrl: string;
  friends: UserSummary[];
  conversations: ConvSummary[];
};
type AdminMessage = {
  id: string;
  senderName: string;
  kind: "text" | "image" | "file" | "contact";
  body: string | null;
  deleted: boolean;
  edited: boolean;
  createdAt: string;
  fileName: string | null;
  imageUrl: string | null;
  fileUrl: string | null;
};
type Unit = "minutes" | "hours" | "days";

const UNIT_LABEL: Record<Unit, string> = { minutes: "分", hours: "時間", days: "日" };
const msg = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");
const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const avatarSrc = (id: string, version: number) => `/api/admin/users/${id}/avatar?v=${version}`;

// 管理者のAPI。期限切れ（401）になったらログイン画面に戻す
async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) window.dispatchEvent(new Event("admin-expired"));
    throw err;
  }
}

export function AdminApp() {
  const [path, setPath] = useState(window.location.pathname);
  const [session, setSession] = useState<"checking" | "in" | "out">("checking");

  const go = (to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
  };

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    const onExpired = () => setSession("out");
    window.addEventListener("popstate", onPop);
    window.addEventListener("admin-expired", onExpired);
    adminApi("/api/admin/session")
      .then(() => setSession("in"))
      .catch(() => setSession("out"));
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("admin-expired", onExpired);
    };
  }, []);

  if (session === "checking") return <div className="boot">読み込み中…</div>;
  if (session === "out") {
    return (
      <AdminLogin
        onDone={() => {
          setSession("in");
          go("/admin");
        }}
      />
    );
  }

  const userMatch = path.match(/^\/admin\/users\/([0-9a-f-]{36})$/i);
  const chatMatch = path.match(/^\/admin\/chats\/([0-9a-f-]{36})$/i);

  const logout = async () => {
    await api("/api/admin/logout", post()).catch(() => undefined);
    setSession("out");
    go("/admin/login");
  };

  return (
    <div className="admin">
      <header className="admin-bar">
        <button className="admin-brand" onClick={() => go("/admin")}>
          <span className="admin-brand-mark">S</span>
          <span>
            SoraChat <small>管理者</small>
          </span>
        </button>
        <button className="admin-logout" onClick={() => void logout()}>
          ログアウト
        </button>
      </header>
      <main className="admin-main">
        {userMatch ? (
          <UserPage id={userMatch[1]} go={go} />
        ) : chatMatch ? (
          <ChatPage id={chatMatch[1]} go={go} />
        ) : (
          <Dashboard go={go} />
        )}
      </main>
    </div>
  );
}

function AdminLogin({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/login", post({ password }));
      onDone();
    } catch (err) {
      setError(msg(err));
      setBusy(false);
    }
  };

  return (
    <div className="admin-login">
      <form className="admin-login-card" onSubmit={submit}>
        <span className="admin-brand-mark large">S</span>
        <h1>管理者ログイン</h1>
        <p className="muted small">SoraChat の管理画面です</p>
        <input
          className="auth-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder="管理者パスワード"
        />
        {error && <p className="notice error center">{error}</p>}
        <button className="btn-primary wide" disabled={busy || !password}>
          ログイン
        </button>
      </form>
    </div>
  );
}

type Go = (to: string) => void;

function Dashboard({ go }: { go: Go }) {
  const [tab, setTab] = useState<"users" | "chats" | "news" | "maintenance">("users");
  return (
    <>
      <div className="admin-segment" role="tablist">
        <button role="tab" aria-selected={tab === "users"} className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>
          ユーザー
        </button>
        <button role="tab" aria-selected={tab === "chats"} className={tab === "chats" ? "on" : ""} onClick={() => setTab("chats")}>
          チャット
        </button>
        <button role="tab" aria-selected={tab === "news"} className={tab === "news" ? "on" : ""} onClick={() => setTab("news")}>
          お知らせ
        </button>
        <button role="tab" aria-selected={tab === "maintenance"} className={tab === "maintenance" ? "on" : ""} onClick={() => setTab("maintenance")}>
          メンテナンス
        </button>
      </div>
      {tab === "users" ? <UsersList go={go} /> : tab === "chats" ? <ChatsList go={go} /> : tab === "news" ? <AnnouncementPanel /> : <MaintenancePanel />}
    </>
  );
}


function MaintenancePanel() {
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("メンテナンス中です。しばらくお待ちください。");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi<{ enabled: boolean; message: string }>("/api/admin/maintenance")
      .then((data) => { setEnabled(data.enabled); setMessage(data.message); })
      .catch((err) => setError(msg(err)))
      .finally(() => setBusy(false));
  }, []);

  const save = async () => {
    setSaving(true); setError(""); setStatus("");
    try {
      const result = await adminApi<{ enabled: boolean; message: string }>("/api/admin/maintenance", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, message })
      });
      setEnabled(result.enabled); setMessage(result.message);
      setStatus(result.enabled ? "メンテナンスモードを有効にしました。" : "メンテナンスモードを解除しました。");
    } catch (err) { setError(msg(err)); }
    finally { setSaving(false); }
  };

  if (busy) return <div className="boot">設定を読み込み中…</div>;
  return <section className="admin-stack">
    <section className="admin-card">
      <h2>メンテナンスモード</h2>
      <p className="muted">ここから切り替えると、サーバーの再起動なしで利用者向け機能を停止・再開できます。管理者パネルと稼働状況ページは引き続き利用できます。</p>
      <label className="admin-maintenance-toggle" style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <strong>{enabled ? "メンテナンスモード：有効" : "メンテナンスモード：無効"}</strong>
      </label>
      <label className="field-label" htmlFor="maintenance-message">利用者に表示するメッセージ</label>
      <textarea id="maintenance-message" className="auth-input" rows={4} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="メンテナンス中です。しばらくお待ちください。" style={{ width: "100%", resize: "vertical", boxSizing: "border-box" }} />
      <p className="muted small">最大500文字。保存するとすぐに反映されます。</p>
      {error && <p className="notice error">{error}</p>}
      {status && <p className="notice">{status}</p>}
      <button className="btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "設定を保存"}</button>
    </section>
  </section>;
}

// お知らせ：開発チームから全ユーザーへ送る。開発チームのアイコンもここで設定できる
function AnnouncementPanel() {
  const [team, setTeam] = useState<UserDetail | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const loadTeam = () =>
    adminApi<UserDetail>(`/api/admin/users/${TEAM_ID}`)
      .then(setTeam)
      .catch((err) => setError(msg(err)));

  useEffect(() => {
    void loadTeam();
  }, []);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    if (!window.confirm("全ユーザーに、開発チームからお知らせを送りますか？\n送ったお知らせは取り消せません。")) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await adminApi<{ ok: boolean; queued: number }>("/api/admin/announcements", post({ body: text }));
      setBody("");
      setStatus(`${result.queued}人に送信を始めました。全員に届くまで少し時間がかかることがあります。`);
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-stack">
      <section className="admin-card admin-team">
        <div className="admin-team-head">
          <Avatar userId={TEAM_ID} hasAvatar={team?.hasAvatar ?? false} name="SoraChat開発チーム" size={56} src={avatarSrc(TEAM_ID, avatarVersion)} />
          <div className="admin-hero-text">
            <h3 className="admin-section-title">SoraChat開発チーム</h3>
            <p className="muted small">お知らせの送り主です。全ユーザーの友だちに入っています。</p>
          </div>
        </div>
        {team && (
          <AvatarPanel
            user={team}
            onChanged={(message) => {
              setStatus(message);
              setAvatarVersion((v) => v + 1);
              void loadTeam();
            }}
            onError={setError}
          />
        )}
      </section>

      <section className="admin-card">
        <h3 className="admin-section-title">お知らせを送る</h3>
        <p className="muted small">全ユーザーの「SoraChat開発チーム」とのトークに届きます（通知も届きます）。</p>
        <textarea
          className="admin-textarea"
          value={body}
          maxLength={1000}
          onChange={(e) => setBody(e.target.value)}
          placeholder="お知らせの本文"
          rows={6}
        />
        <p className="muted small admin-count">{body.length}/1000</p>
        <div className="admin-actions">
          <button className="btn-primary" disabled={busy || !body.trim()} onClick={() => void send()}>
            {busy ? "送信中…" : "全ユーザーに送る"}
          </button>
        </div>
      </section>

      {status && <p className="admin-status">{status}</p>}
      {error && <p className="notice error">{error}</p>}
    </section>
  );
}

function BanTag({ ban }: { ban: BanInfo | null }) {
  if (!ban) return null;
  return <span className="admin-tag ban">{ban.permanent ? "永久BAN" : "利用停止"}</span>;
}

function UsersList({ go }: { go: Go }) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      adminApi<UserSummary[]>(`/api/admin/users?q=${encodeURIComponent(q)}`)
        .then((list) => {
          setUsers(list);
          setError("");
        })
        .catch((err) => setError(msg(err)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  return (
    <section className="admin-stack">
      <div className="admin-search-wrap">
        <input className="admin-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ユーザー名・名前で検索" />
      </div>
      {error && <p className="notice error">{error}</p>}
      {!users ? (
        <p className="muted">読み込み中…</p>
      ) : users.length === 0 ? (
        <p className="muted admin-empty">該当するユーザーがいません。</p>
      ) : (
        <ul className="admin-list">
          {users.map((u) => (
            <li key={u.id}>
              <button className="admin-row" onClick={() => go(`/admin/users/${u.id}`)}>
                <Avatar userId={u.id} hasAvatar={u.hasAvatar} name={u.displayName} size={42} src={`/api/admin/users/${u.id}/avatar`} />
                <span className="admin-row-text">
                  <strong>
                    {u.displayName}
                    {u.sennin && <small className="admin-badge">仙人</small>}
                    {u.id === TEAM_ID && <small className="admin-badge">開発チーム</small>}
                  </strong>
                  <small>@{u.username}</small>
                </span>
                <BanTag ban={u.ban} />
                <span className="admin-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChatsList({ go }: { go: Go }) {
  const [q, setQ] = useState("");
  const [chats, setChats] = useState<ConvSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi<ConvSummary[]>("/api/admin/conversations")
      .then(setChats)
      .catch((err) => setError(msg(err)));
  }, []);

  const shown = (chats ?? []).filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <section className="admin-stack">
      <div className="admin-search-wrap">
        <input className="admin-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="チャット名・メンバー名で絞り込み" />
      </div>
      {error && <p className="notice error">{error}</p>}
      {!chats ? (
        <p className="muted">読み込み中…</p>
      ) : shown.length === 0 ? (
        <p className="muted admin-empty">チャットがありません。</p>
      ) : (
        <ul className="admin-list">
          {shown.map((c) => (
            <li key={c.id}>
              <button className="admin-row" onClick={() => go(`/admin/chats/${c.id}`)}>
                <span className="admin-chat-icon" aria-hidden="true">
                  {c.isGroup ? "◎" : "●"}
                </span>
                <span className="admin-row-text">
                  <strong>
                    {c.name}
                    {c.isOpen && <small className="admin-badge">オープン</small>}
                    {c.isGroup && !c.isOpen && <small className="admin-badge">グループ</small>}
                  </strong>
                  <small>
                    {c.memberCount}人 ・ {c.lastPreview ?? "まだメッセージがありません"}
                  </small>
                </span>
                <span className="admin-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UserPage({ id, go }: { id: string; go: Go }) {
  const [user, setUser] = useState<UserDetail | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [friendName, setFriendName] = useState("");
  const [avatarVersion, setAvatarVersion] = useState(0);

  const load = () =>
    adminApi<UserDetail>(`/api/admin/users/${id}`)
      .then(setUser)
      .catch((err) => setError(msg(err)));

  useEffect(() => {
    setUser(null);
    setError("");
    setStatus("");
    void load();
  }, [id]);

  // 操作のあとは、状態の表示を更新する（アイコンは表示の番号を変えて、新しい画像を読み直す）
  const changed = (message: string, avatarChanged = false) => {
    setStatus(message);
    if (avatarChanged) setAvatarVersion((v) => v + 1);
    void load();
  };

  const addFriend = async (event: FormEvent) => {
    event.preventDefault();
    const username = friendName.trim().toLowerCase();
    if (!username) return;
    setStatus("");
    try {
      await adminApi(`/api/admin/users/${id}/friends`, post({ username }));
      setFriendName("");
      changed("友だちに追加しました。");
    } catch (err) {
      setStatus(msg(err));
    }
  };

  if (error) return <p className="notice error">{error}</p>;
  if (!user) return <p className="muted">読み込み中…</p>;

  return (
    <>
      <button className="admin-back" onClick={() => go("/admin")}>
        ← 一覧に戻る
      </button>

      <section className="admin-card admin-hero">
        <div className="admin-hero-avatar">
          <Avatar userId={user.id} hasAvatar={user.hasAvatar} name={user.displayName} size={84} src={avatarSrc(user.id, avatarVersion)} />
        </div>
        <div className="admin-hero-text">
          <h2>
            {user.displayName}
            {user.sennin && <small className="admin-badge">仙人</small>}
          </h2>
          <p className="muted">@{user.username}</p>
          {user.ban ? (
            <span className="admin-tag ban big">
              {user.ban.permanent ? "永久に利用停止中" : `利用停止中（${fmt(user.ban.until!)} まで）`}
            </span>
          ) : (
            <span className="admin-tag ok big">利用中</span>
          )}
        </div>
      </section>

      {status && <p className="admin-status">{status}</p>}

      <section className="admin-card">
        <h3 className="admin-section-title">基本情報</h3>
        <dl className="admin-dl">
          <dt>自己紹介</dt>
          <dd>{user.bio || "—"}</dd>
          <dt>連絡先</dt>
          <dd>{user.contact || "—"}</dd>
          <dt>Webサイト</dt>
          <dd>{user.profileUrl || "—"}</dd>
          <dt>登録日</dt>
          <dd>{fmt(user.createdAt)}</dd>
          <dt>ユーザーID</dt>
          <dd className="mono">{user.id}</dd>
        </dl>
      </section>

      <AvatarPanel user={user} onChanged={(message) => changed(message, true)} onError={setStatus} />

      <BanPanel user={user} onChanged={changed} onError={setStatus} />

      <PasswordPanel user={user} onChanged={changed} onError={setStatus} />

      <section className="admin-card">
        <h3 className="admin-section-title">友だちを追加</h3>
        <p className="muted small">管理者は、相手の承認なしで誰とでも友だちにできます。</p>
        <form className="admin-inline" onSubmit={addFriend}>
          <input className="auth-input" value={friendName} onChange={(e) => setFriendName(e.target.value)} placeholder="ユーザー名" autoCapitalize="none" />
          <button className="btn-primary" disabled={!friendName.trim()}>
            追加
          </button>
        </form>
      </section>

      <section className="admin-card">
        <h3 className="admin-section-title">友だち（{user.friends.length}人）</h3>
        {user.friends.length === 0 ? (
          <p className="muted small">友だちはいません。</p>
        ) : (
          <ul className="admin-list">
            {user.friends.map((f) => (
              <li key={f.id}>
                <button className="admin-row" onClick={() => go(`/admin/users/${f.id}`)}>
                  <Avatar userId={f.id} hasAvatar={f.hasAvatar} name={f.displayName} size={36} src={`/api/admin/users/${f.id}/avatar`} />
                  <span className="admin-row-text">
                    <strong>{f.displayName}</strong>
                    <small>@{f.username}</small>
                  </span>
                  <BanTag ban={f.ban} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-card">
        <h3 className="admin-section-title">参加しているチャット（{user.conversations.length}件）</h3>
        {user.conversations.length === 0 ? (
          <p className="muted small">参加しているチャットはありません。</p>
        ) : (
          <ul className="admin-list">
            {user.conversations.map((c) => (
              <li key={c.id}>
                <button className="admin-row" onClick={() => go(`/admin/chats/${c.id}`)}>
                  <span className="admin-chat-icon" aria-hidden="true">
                    {c.isGroup ? "◎" : "●"}
                  </span>
                  <span className="admin-row-text">
                    <strong>
                      {c.name}
                      {c.isOpen && <small className="admin-badge">オープン</small>}
                    </strong>
                    <small>{c.memberCount}人</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// パスワードの再設定。今のパスワードは見られない（保存されているのはハッシュだけ）。新しく設定して本人に伝える
function PasswordPanel({ user, onChanged, onError }: { user: UserDetail; onChanged: (message: string) => void; onError: (message: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = password.length >= 8 && password.length <= 72;

  const apply = async () => {
    if (!valid) {
      setError("8文字以上72文字以内で入力してください。");
      return;
    }
    if (!window.confirm(`${user.displayName} のパスワードを新しく設定しますか？\n今のログインは全て切れます。`)) return;
    setBusy(true);
    setError("");
    try {
      await adminApi(`/api/admin/users/${user.id}/password`, post({ password }));
      setPassword("");
      onChanged("パスワードを再設定しました。新しいパスワードを本人にお伝えください。");
    } catch (err) {
      setError(msg(err));
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-card">
      <h3 className="admin-section-title">パスワードの再設定</h3>
      <p className="muted small">今のパスワードは見られません。新しく設定して、本人にお伝えください。入力中の文字は画面に表示されます。</p>
      <label className="admin-field">
        <span className="muted small">新しいパスワード（8〜72文字）</span>
        <input
          className="auth-input"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          value={password}
          maxLength={72}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="新しいパスワード"
        />
      </label>
      {error && <p className="notice error">{error}</p>}
      <div className="admin-actions">
        <button className="btn-primary" disabled={busy || !password} onClick={() => void apply()}>
          {busy ? "設定中…" : "パスワードを設定する"}
        </button>
      </div>
    </section>
  );
}

// アイコン画像の設定・削除（不適切な画像の差し替えや削除ができる）
function AvatarPanel({ user, onChanged, onError }: { user: UserDetail; onChanged: (message: string) => void; onError: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    // アイコンは送る前に圧縮する
    const small = await compressImage(file, AVATAR_OPTIONS);
    const form = new FormData();
    form.append("file", small, small.name);
    setBusy(true);
    try {
      await adminApi(`/api/admin/users/${user.id}/avatar`, { method: "POST", body: form });
      onChanged("アイコンを設定しました。");
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async () => {
    if (!window.confirm(`${user.displayName} のアイコンを削除しますか？\n削除すると、名前の1文字が表示されます。`)) return;
    setBusy(true);
    try {
      await adminApi(`/api/admin/users/${user.id}/avatar`, delete_());
      onChanged("アイコンを削除しました。");
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-card">
      <h3 className="admin-section-title">アイコン画像</h3>
      <p className="muted small">JPEG・PNG・WebP・GIF（10MBまで）を設定できます。</p>
      <div className="admin-avatar-actions">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button className="btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? "処理中…" : user.hasAvatar ? "画像を差し替える" : "画像を設定する"}
        </button>
        {user.hasAvatar && (
          <button className="btn-danger" disabled={busy} onClick={() => void remove()}>
            画像を削除
          </button>
        )}
      </div>
    </section>
  );
}

// 利用停止（BAN）。期間を指定するか、永久にするかを選ぶ
function BanPanel({ user, onChanged, onError }: { user: UserDetail; onChanged: (message: string) => void; onError: (message: string) => void }) {
  const [mode, setMode] = useState<"duration" | "permanent">("duration");
  const [amount, setAmount] = useState("3");
  const [unit, setUnit] = useState<Unit>("days");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ban = user.ban;
  const [reason, setReason] = useState(user.ban?.reason ?? "");
  const amountNumber = Number(amount);
  const validAmount = Number.isInteger(amountNumber) && amountNumber >= 1 && amountNumber <= 100000;
  const label = mode === "permanent" ? "永久" : `${amountNumber}${UNIT_LABEL[unit]}`;

  const apply = async () => {
    if (mode === "duration" && !validAmount) {
      setError("1以上の整数を入力してください。");
      return;
    }
    if (!window.confirm(`${user.displayName} を${label}利用停止にしますか？\n利用者の画面は「バンされました」の表示に切り替わります。`)) return;
    setBusy(true);
    setError("");
    try {
      const period = mode === "permanent" ? { permanent: true } : { permanent: false, amount: amountNumber, unit };
      const body = { ...period, reason: reason.trim() };
      await adminApi(`/api/admin/users/${user.id}/ban`, post(body));
      onChanged(`${label}の利用停止にしました。`);
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const unban = async () => {
    if (!window.confirm(`${user.displayName} の利用停止を解除しますか？`)) return;
    setBusy(true);
    try {
      await adminApi(`/api/admin/users/${user.id}/unban`, post());
      onChanged("利用停止を解除しました。");
    } catch (err) {
      onError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-card">
      <h3 className="admin-section-title">利用停止（BAN）</h3>
      {ban ? (
        <div className="admin-ban-now">
          <strong>
            {ban.permanent ? "永久に利用停止中です" : `${fmt(ban.until!)} まで利用停止中`}
          </strong>
          {!ban.permanent && <small>残り {formatRemaining(new Date(ban.until!).getTime() - Date.now())}</small>}
          {ban.reason && <small>理由：{ban.reason}</small>}
        </div>
      ) : (
        <p className="muted small">いまは利用中です。停止する期間を選んでください。</p>
      )}

      <div className="admin-segment small" role="radiogroup" aria-label="利用停止の種類">
        <button type="button" role="radio" aria-checked={mode === "duration"} className={mode === "duration" ? "on" : ""} onClick={() => setMode("duration")}>
          期間を指定
        </button>
        <button type="button" role="radio" aria-checked={mode === "permanent"} className={mode === "permanent" ? "on danger" : ""} onClick={() => setMode("permanent")}>
          永久
        </button>
      </div>

      {mode === "duration" ? (
        <div className="admin-ban-duration">
          <input
            className="auth-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="期間の数"
          />
          <select className="admin-select" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="期間の単位">
            <option value="minutes">分</option>
            <option value="hours">時間</option>
            <option value="days">日</option>
          </select>
        </div>
      ) : (
        <p className="admin-warn">永久の利用停止は、解除するまで続きます。</p>
      )}

      <label className="admin-field">
        <span className="muted small">理由（任意・利用者の画面に表示されます）</span>
        <input
          className="auth-input"
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例：不適切な投稿のため"
        />
      </label>

      {error && <p className="notice error">{error}</p>}

      <div className="admin-actions">
        <button
          className={mode === "permanent" ? "btn-danger" : "btn-primary"}
          disabled={busy || (mode === "duration" && !validAmount)}
          onClick={() => void apply()}
        >
          {ban ? `${label}に変更する` : `${label}の利用停止にする`}
        </button>
        {ban && (
          <button className="btn-secondary" disabled={busy} onClick={() => void unban()}>
            解除する
          </button>
        )}
      </div>
    </section>
  );
}

function ChatPage({ id, go }: { id: string; go: Go }) {
  const [info, setInfo] = useState<ConvSummary | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setInfo(null);
    setMessages([]);
    setError("");
    Promise.all([
      adminApi<ConvSummary>(`/api/admin/conversations/${id}`),
      adminApi<AdminMessage[]>(`/api/admin/conversations/${id}/messages`)
    ])
      .then(([summary, list]) => {
        setInfo(summary);
        setMessages(list);
        setHasOlder(list.length === 50);
      })
      .catch((err) => setError(msg(err)));
  }, [id]);

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const list = await adminApi<AdminMessage[]>(`/api/admin/conversations/${id}/messages?before=${encodeURIComponent(oldest.createdAt)}`);
      setMessages((current) => [...list, ...current]);
      setHasOlder(list.length === 50);
    } catch (err) {
      setError(msg(err));
    } finally {
      setLoadingOlder(false);
    }
  };

  // メッセージを完全に削除する（取り消しの表示は残さない。相手の画面からも消える）
  const removeMessage = async (messageId: string) => {
    if (!window.confirm("このメッセージを削除しますか？\n削除すると、相手の画面からも消えます（取り消しの表示は残りません）。")) return;
    try {
      await adminApi(`/api/admin/messages/${messageId}`, delete_());
      setMessages((current) => current.filter((m) => m.id !== messageId));
    } catch (err) {
      setError(msg(err));
    }
  };

  if (error) return <p className="notice error">{error}</p>;
  if (!info) return <p className="muted">読み込み中…</p>;

  return (
    <>
      <button className="admin-back" onClick={() => go("/admin")}>
        ← 一覧に戻る
      </button>
      <section className="admin-card">
        <h2 className="admin-chat-title">{info.name}</h2>
        <p className="muted small">
          {info.isOpen ? "オープンチャット・" : info.isGroup ? "グループ・" : "1対1・"}
          {info.memberCount}人 ・ 閲覧のみ（管理者は送信・編集できません）
        </p>
        <div className="admin-members">
          {info.members.map((m) => (
            <button key={m.id} className="admin-chip" onClick={() => go(`/admin/users/${m.id}`)}>
              {m.displayName}（@{m.username}）{m.role === "owner" ? " ・管理者" : ""}
            </button>
          ))}
        </div>
      </section>

      <div className="admin-msgs">
        {hasOlder && (
          <button className="btn-secondary" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? "読み込み中…" : "以前のメッセージを表示"}
          </button>
        )}
        {messages.length === 0 && <p className="muted small">メッセージはまだありません。</p>}
        {messages.map((m) => (
          <div key={m.id} className="admin-msg">
            <div className="admin-msg-head">
              <strong>{m.senderName}</strong>
              <time>{fmt(m.createdAt)}</time>
              {m.edited && !m.deleted && <span>編集済み</span>}
              <button className="admin-msg-delete" onClick={() => void removeMessage(m.id)}>
                削除
              </button>
            </div>
            {m.deleted ? (
              <p className="deleted">送信を取り消しました</p>
            ) : m.kind === "image" && m.imageUrl ? (
              <img src={m.imageUrl} alt="画像" loading="lazy" />
            ) : m.kind === "file" && m.fileUrl ? (
              <a href={m.fileUrl} download={m.fileName ?? undefined}>
                {m.fileName ?? "ファイル"}
              </a>
            ) : m.kind === "contact" ? (
              <p className="muted">（連絡先）</p>
            ) : (
              <p>{m.body}</p>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
