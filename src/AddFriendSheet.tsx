import { useEffect, useState } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { QrScanner } from "./QrScanner";
import { usernameFromQr } from "./qr";
import { UserRow } from "./UserRow";

type Mode = "search" | "qr";
type Found = { id: string; username: string; displayName: string; hasAvatar: boolean; isFriend: boolean };

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

// 「友だち追加」画面：ユーザー名で検索、またはQRコードを読み取って友だちに追加する
export function AddFriendSheet({
  onClose,
  onAdded,
  onOpenDm,
}: {
  onClose: () => void;
  onAdded: () => void;
  onOpenDm: (username: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<Mode>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Found[]>([]);
  const [scanned, setScanned] = useState<Found | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // 申請を送ったが、まだ相手が許可していないユーザー名
  const [requested, setRequested] = useState<string[]>([]);

  const keyword = query.trim().toLowerCase();

  useEffect(() => {
    if (mode !== "search" || !keyword) {
      setResults([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api<Found[]>(`/api/users/suggest?q=${encodeURIComponent(keyword)}`)
        .then((items) => alive && setResults(items))
        .catch(() => alive && setResults([]));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [keyword, mode]);

  // フレンド申請を送る。相手が許可するまでは申請中のまま（申請中でもDMは送れる）。
  // 送ったらそのままトークを開く。開けなかったときだけ案内を出す。
  const addFriend = async (username: string) => {
    setBusy(username);
    setError("");
    let result: { status: "friend" | "outgoing"; id: string };
    try {
      result = await api<{ status: "friend" | "outgoing"; id: string }>("/api/friends", post({ username }));
    } catch (err) {
      setError(messageOf(err));
      setBusy("");
      return;
    }
    const isFriend = result.status === "friend";
    setResults((list) => list.map((u) => (u.username === username ? { ...u, isFriend } : u)));
    setScanned((s) => (s && s.username === username ? { ...s, isFriend } : s));
    if (!isFriend) setRequested((list) => [...list, username]);
    setJustAdded(result.id);
    onAdded();
    const opened = await onOpenDm(username);
    if (!opened) {
      setError(
        isFriend
          ? "友だちに追加しました。トークは「トーク」タブから開けます。"
          : "フレンドリクエストを送りました。トークは「トーク」タブから開けます。"
      );
    }
    setBusy("");
  };

  // QRを読み取ったら、相手を確認してから友だちに追加する
  const onQrDetect = async (value: string) => {
    const name = usernameFromQr(value);
    if (!name) {
      setError("SoraChatのQRコードではありません。");
      return;
    }
    try {
      const found = await api<Found>(`/api/users/by-username?username=${encodeURIComponent(name)}`);
      setScanned({ ...found, isFriend: false });
      setError("");
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const changeMode = (next: Mode) => {
    setError("");
    setScanned(null);
    setMode(next);
  };

  return (
    <div className="page" role="dialog" aria-label="友だち追加">
      <header className="page-bar">
        <button onClick={onClose} aria-label="閉じる">
          <Icon name="close" size={24} />
        </button>
        <strong>友だち追加</strong>
        <span />
      </header>

      {mode === "search" && (
        <>
          <div className="search-bar">
            <label className="search-field">
              <Icon name="search" size={16} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ユーザー名で検索"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                maxLength={20}
                aria-label="ユーザー名"
              />
            </label>
          </div>

          <ul className="user-list-ul">
            {results.map((user, i) => (
              <UserRow
                key={user.id}
                index={i}
                userId={user.id}
                hasAvatar={user.hasAvatar}
                name={user.displayName}
                sub={`@${user.username}`}
                right={
                  user.isFriend ? (
                    <span className={`added-tag ${justAdded === user.id ? "pop" : ""}`}>
                      <Icon name="check" size={16} /> 追加済み
                    </span>
                  ) : requested.includes(user.username) ? (
                    <span className="added-tag">申請中</span>
                  ) : (
                    <button className="btn-small accent" disabled={busy === user.username} onClick={() => void addFriend(user.username)}>
                      {busy === user.username ? "送信中…" : "追加"}
                    </button>
                  )
                }
              />
            ))}
          </ul>

          {keyword && !results.length && <p className="muted center pad">該当するユーザーが見つかりませんでした。</p>}

          <div className="option-list">
            <button onClick={() => changeMode("qr")}>
              <span className="option-icon">
                <Icon name="qr" size={20} />
              </span>
              <span>QRコードで追加</span>
              <Icon name="chevron" size={18} className="chev" />
            </button>
          </div>
        </>
      )}

      {mode === "qr" && (
        <div className="qr-mode">
          {scanned ? (
            <div className="qr-found">
              <Avatar userId={scanned.id} hasAvatar={scanned.hasAvatar} name={scanned.displayName} size={96} />
              <strong className="hero-name">{scanned.displayName}</strong>
              <span className="muted">@{scanned.username}</span>
              {scanned.isFriend ? (
                <span className="added-tag pop big">
                  <Icon name="check" size={18} /> 友だち追加済み
                </span>
              ) : requested.includes(scanned.username) ? (
                <span className="added-tag big">申請中</span>
              ) : (
                <button className="btn-primary wide" disabled={busy === scanned.username} onClick={() => void addFriend(scanned.username)}>
                  {busy === scanned.username ? "送信中…" : "フレンド申請を送る"}
                </button>
              )}
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

      {error && <p className="notice center error shake">{error}</p>}
    </div>
  );
}
