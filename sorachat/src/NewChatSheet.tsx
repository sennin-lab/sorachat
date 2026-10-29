import { useEffect, useState } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { QrScanner } from "./QrScanner";
import { usernameFromQr } from "./qr";

type Mode = "search" | "qr" | "group";
type User = { id: string; username: string; displayName: string; hasAvatar: boolean };

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

export function NewChatSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<Mode>("search");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<User[]>([]);
  const [scanned, setScanned] = useState<User | null>(null);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const username = query.trim().toLowerCase();
  const usernames = members.split(/[ ,\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

  // ユーザー名の候補（入力に合わせて検索）
  useEffect(() => {
    if (mode !== "search" || username.length < 1) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api<User[]>(`/api/users/suggest?q=${encodeURIComponent(username)}`)
        .then((items) => alive && setSuggestions(items))
        .catch(() => alive && setSuggestions([]));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [username, mode]);

  const openDirect = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/api/dm/open", post({ username: name }));
      onOpen(result.id);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  // QRを読み取ったら相手を確認してから開始する
  const onQrDetect = async (value: string) => {
    const name = usernameFromQr(value);
    if (!name) {
      setError("SoraChatのQRコードではありません。");
      return;
    }
    try {
      const user = await api<User>(`/api/users/by-username?username=${encodeURIComponent(name)}`);
      setScanned(user);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const createGroup = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/api/dm/group", post({ title: title.trim(), usernames }));
      onOpen(result.id);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const changeMode = (next: Mode) => {
    setError("");
    setScanned(null);
    setMode(next);
  };

  return (
    <div className="page" role="dialog" aria-label="新規メッセージ">
      <header className="page-bar">
        <button onClick={onClose} aria-label="閉じる">
          <Icon name="close" size={24} />
        </button>
        <strong>新規メッセージ</strong>
        <span />
      </header>

      {mode === "search" && (
        <>
          <div className="to-row">
            <span>宛先:</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ユーザー名を検索"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              maxLength={20}
            />
          </div>
          <ul className="user-list">
            {suggestions.map((user) => (
              <li key={user.id}>
                <button onClick={() => void openDirect(user.username)} disabled={busy}>
                  <Avatar userId={user.id} hasAvatar={user.hasAvatar} name={user.displayName} size={44} />
                  <span className="user-text">
                    <strong>{user.displayName}</strong>
                    <small>{user.username}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {username.length >= 3 && !suggestions.length && (
            <button className="btn-primary wide" onClick={() => void openDirect(username)} disabled={busy}>
              {busy ? "開いています…" : `@${username} とのチャットを開く`}
            </button>
          )}
          <div className="option-list">
            <button onClick={() => changeMode("qr")}>
              <Icon name="qr" size={22} /> <span>QRコードで追加</span> <Icon name="chevron" size={18} className="chev" />
            </button>
            <button onClick={() => changeMode("group")}>
              <Icon name="users" size={22} /> <span>グループを作成</span> <Icon name="chevron" size={18} className="chev" />
            </button>
          </div>
        </>
      )}

      {mode === "qr" && (
        <div className="qr-mode">
          {scanned ? (
            <div className="qr-found">
              <Avatar userId={scanned.id} hasAvatar={scanned.hasAvatar} name={scanned.displayName} size={88} />
              <strong>{scanned.displayName}</strong>
              <span className="muted">{scanned.username}</span>
              <button className="btn-primary wide" onClick={() => void openDirect(scanned.username)} disabled={busy}>
                メッセージを送る
              </button>
              <button className="btn-text" onClick={() => setScanned(null)}>
                もう一度読み取る
              </button>
            </div>
          ) : (
            <>
              <QrScanner onDetect={(value) => void onQrDetect(value)} />
              <p className="muted center">相手のQRコードを枠内に映してください。</p>
            </>
          )}
          <button className="btn-text" onClick={() => changeMode("search")}>
            ユーザー名で検索
          </button>
        </div>
      )}

      {mode === "group" && (
        <div className="group-mode">
          <label className="field">
            <span>グループ名</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} autoFocus />
          </label>
          <label className="field">
            <span>メンバー（ユーザー名、カンマ区切り）</span>
            <textarea
              value={members}
              onChange={(e) => setMembers(e.target.value)}
              rows={3}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="sora_01, kaito_22"
            />
          </label>
          <button
            className="btn-primary wide"
            onClick={() => void createGroup()}
            disabled={busy || !title.trim() || usernames.length === 0}
          >
            {busy ? "作成中…" : "グループを作成"}
          </button>
          <button className="btn-text" onClick={() => changeMode("search")}>
            戻る
          </button>
        </div>
      )}

      {error && <p className="notice center error">{error}</p>}
    </div>
  );
}
