import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";

// 管理者パネル（/admin/login からだけ入る。一般の画面からは入口を出さない）
type UserSummary = { id: string; username: string; displayName: string; hasAvatar: boolean; sennin: boolean; createdAt: string; bannedAt: string | null };
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

const msg = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");
const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

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
          SoraChat 管理者
        </button>
        <button className="btn-text" onClick={() => void logout()}>
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
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="wordmark">管理者</h1>
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
  const [tab, setTab] = useState<"users" | "chats">("users");
  return (
    <>
      <div className="admin-tabs">
        <button className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>
          ユーザー
        </button>
        <button className={tab === "chats" ? "on" : ""} onClick={() => setTab("chats")}>
          チャット
        </button>
      </div>
      {tab === "users" ? <UsersList go={go} /> : <ChatsList go={go} />}
    </>
  );
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
      <input className="auth-input admin-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ユーザー名・名前で検索" />
      {error && <p className="notice error">{error}</p>}
      {!users ? (
        <p className="muted">読み込み中…</p>
      ) : users.length === 0 ? (
        <p className="muted">該当するユーザーがいません。</p>
      ) : (
        <ul className="admin-list">
          {users.map((u) => (
            <li key={u.id}>
              <button className="admin-row" onClick={() => go(`/admin/users/${u.id}`)}>
                <Avatar userId={u.id} hasAvatar={u.hasAvatar} name={u.displayName} size={40} src={`/api/admin/users/${u.id}/avatar`} />
                <span className="admin-row-text">
                  <strong>
                    {u.displayName}
                    {u.sennin && <small> 仙人</small>}
                  </strong>
                  <small>@{u.username}</small>
                </span>
                {u.bannedAt ? <span className="admin-tag ban">利用停止</span> : null}
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
      <input className="auth-input admin-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="チャット名・メンバー名で絞り込み" />
      {error && <p className="notice error">{error}</p>}
      {!chats ? (
        <p className="muted">読み込み中…</p>
      ) : shown.length === 0 ? (
        <p className="muted">チャットがありません。</p>
      ) : (
        <ul className="admin-list">
          {shown.map((c) => (
            <li key={c.id}>
              <button className="admin-row" onClick={() => go(`/admin/chats/${c.id}`)}>
                <span className="admin-row-text">
                  <strong>
                    {c.name}
                    {c.isOpen && <small> オープン</small>}
                    {c.isGroup && !c.isOpen && <small> グループ</small>}
                  </strong>
                  <small>
                    {c.memberCount}人 ・ {c.lastPreview ?? "まだメッセージがありません"}
                  </small>
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
  const [busy, setBusy] = useState(false);

  const load = () =>
    adminApi<UserDetail>(`/api/admin/users/${id}`)
      .then(setUser)
      .catch((err) => setError(msg(err)));

  useEffect(() => {
    setUser(null);
    setError("");
    void load();
  }, [id]);

  const toggleBan = async () => {
    if (!user) return;
    const banning = !user.bannedAt;
    if (!window.confirm(banning ? `${user.displayName} を利用停止にしますか？\nログインできなくなり、今のログインも切れます。` : "利用停止を解除しますか？")) return;
    setBusy(true);
    setStatus("");
    try {
      await adminApi(`/api/admin/users/${id}/${banning ? "ban" : "unban"}`, post());
      setStatus(banning ? "利用停止にしました。" : "利用停止を解除しました。");
      await load();
    } catch (err) {
      setStatus(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const addFriend = async (event: FormEvent) => {
    event.preventDefault();
    const username = friendName.trim().toLowerCase();
    if (!username) return;
    setStatus("");
    try {
      await adminApi(`/api/admin/users/${id}/friends`, post({ username }));
      setFriendName("");
      setStatus("友だちに追加しました。");
      await load();
    } catch (err) {
      setStatus(msg(err));
    }
  };

  if (error) return <p className="notice error">{error}</p>;
  if (!user) return <p className="muted">読み込み中…</p>;

  return (
    <>
      <button className="btn-text" onClick={() => go("/admin")}>
        ← 一覧に戻る
      </button>

      <section className="admin-card">
        <div className="admin-profile">
          <Avatar userId={user.id} hasAvatar={user.hasAvatar} name={user.displayName} size={72} src={`/api/admin/users/${user.id}/avatar`} />
          <div>
            <h2>{user.displayName}</h2>
            <p className="muted">@{user.username}</p>
            {user.sennin && <p className="muted small">仙人アカウント連携</p>}
            {user.bannedAt ? <span className="admin-tag ban">利用停止中（{fmt(user.bannedAt)}〜）</span> : <span className="admin-tag ok">利用中</span>}
          </div>
        </div>
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
        <div className="admin-actions">
          <button className={user.bannedAt ? "btn-secondary" : "btn-danger"} disabled={busy} onClick={() => void toggleBan()}>
            {user.bannedAt ? "利用停止を解除" : "利用停止（BAN）にする"}
          </button>
        </div>
        {status && <p className="notice center">{status}</p>}
      </section>

      <section className="admin-card">
        <h3>友だちを追加</h3>
        <p className="muted small">管理者は、相手の承認なしで誰とでも友だちにできます。</p>
        <form className="admin-inline" onSubmit={addFriend}>
          <input className="auth-input" value={friendName} onChange={(e) => setFriendName(e.target.value)} placeholder="ユーザー名" autoCapitalize="none" />
          <button className="btn-primary" disabled={!friendName.trim()}>
            追加
          </button>
        </form>
      </section>

      <section className="admin-card">
        <h3>友だち（{user.friends.length}人）</h3>
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
                  {f.bannedAt ? <span className="admin-tag ban">利用停止</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-card">
        <h3>参加しているチャット（{user.conversations.length}件）</h3>
        {user.conversations.length === 0 ? (
          <p className="muted small">参加しているチャットはありません。</p>
        ) : (
          <ul className="admin-list">
            {user.conversations.map((c) => (
              <li key={c.id}>
                <button className="admin-row" onClick={() => go(`/admin/chats/${c.id}`)}>
                  <span className="admin-row-text">
                    <strong>
                      {c.name}
                      {c.isOpen && <small> オープン</small>}
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

  if (error) return <p className="notice error">{error}</p>;
  if (!info) return <p className="muted">読み込み中…</p>;

  return (
    <>
      <button className="btn-text" onClick={() => go("/admin")}>
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
