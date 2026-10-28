import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";

type Tab = "direct" | "group";
type FriendMode = "search" | "qr";
type SuggestedUser = { id: string; username: string; displayName: string; hasAvatar: boolean };

export function NewChatSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("direct");
  const [friendMode, setFriendMode] = useState<FriendMode>("search");
  const [username, setUsername] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestedUser[]>([]);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [scanStatus, setScanStatus] = useState("カメラを起動してQRコードを読み取れます。");

  const usernames = members.split(/[ ,\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

  useEffect(() => {
    if (tab !== "direct" || friendMode !== "search" || username.trim().length < 1) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api<SuggestedUser[]>(`/api/users/suggest?q=${encodeURIComponent(username.trim().toLowerCase())}`)
        .then((items) => { if (alive) setSuggestions(items); })
        .catch(() => { if (alive) setSuggestions([]); });
    }, 180);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [username, tab, friendMode]);

  useEffect(() => {
    if (tab !== "direct" || friendMode !== "qr") return;
    let stream: MediaStream | null = null;
    let active = true;
    let timer = 0;
    const start = async () => {
      try {
        if (!("BarcodeDetector" in window)) {
          setScanStatus("このブラウザでは自動読み取りに対応していません。ユーザー名を入力してください。");
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (!active || !videoRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const Detector = (window as any).BarcodeDetector;
        const detector = new Detector({ formats: ["qr_code"] });
        const scan = async () => {
          if (!active || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes?.[0]?.rawValue ?? "";
            const match = value.match(/(?:sorachat:\/\/user\/|@)([a-z0-9_]{3,20})/i);
            if (match) {
              setUsername(match[1].toLowerCase());
              setScanStatus(`@${match[1]} を読み取りました。`);
              setFriendMode("search");
              return;
            }
          } catch { /* ignore a single frame error */ }
          timer = window.setTimeout(scan, 300);
        };
        setScanStatus("QRコードをカメラに映してください。");
        scan();
      } catch {
        setScanStatus("カメラを利用できません。ブラウザのカメラ権限を確認してください。");
      }
    };
    start();
    return () => {
      active = false;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [tab, friendMode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = tab === "direct"
        ? await api<{ id: string }>("/api/dm/open", post({ username: username.trim().toLowerCase() }))
        : await api<{ id: string }>("/api/dm/group", post({ title: title.trim(), usernames }));
      onOpen(result.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "通信に失敗しました。");
      setBusy(false);
    }
  };

  const ready = tab === "direct" ? username.trim().length >= 3 : title.trim().length > 0 && usernames.length > 0;
  const qrValue = `sorachat://user/${username.trim().toLowerCase()}`;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet new-chat-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-title-row">
          <div><span className="eyebrow">START A CONVERSATION</span><h2>新しいトーク</h2></div>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる"><i className="fa-solid fa-xmark" /></button>
        </header>
        <div className="seg">
          <button className={tab === "direct" ? "on" : ""} onClick={() => setTab("direct")}><i className="fa-solid fa-user" /> 友達を追加</button>
          <button className={tab === "group" ? "on" : ""} onClick={() => setTab("group")}><i className="fa-solid fa-users" /> グループ</button>
        </div>
        <form onSubmit={submit} className="sheet-form">
          {tab === "direct" ? (
            <>
              <div className="mode-tabs">
                <button type="button" className={friendMode === "search" ? "active" : ""} onClick={() => setFriendMode("search")}><i className="fa-solid fa-magnifying-glass" /> ユーザー名で検索</button>
                <button type="button" className={friendMode === "qr" ? "active" : ""} onClick={() => setFriendMode("qr")}><i className="fa-solid fa-qrcode" /> QRコード</button>
              </div>
              {friendMode === "search" ? (
                <div className="suggest-wrap">
                  <label className="field">
                    <span>ユーザー名</span>
                    <div className="search-input-wrap"><i className="fa-solid fa-at" /><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ユーザー名を入力" autoFocus autoCapitalize="none" autoCorrect="off" maxLength={20} /></div>
                  </label>
                  {suggestions.length > 0 && (
                    <div className="suggestions" role="listbox" aria-label="ユーザー候補">
                      {suggestions.map((user) => <button type="button" className="suggestion" key={user.id} onClick={() => { setUsername(user.username); setSuggestions([]); }}>
                        <Avatar userId={user.id} hasAvatar={user.hasAvatar} name={user.displayName} size={40} />
                        <span className="suggestion-copy"><strong>{user.displayName}</strong><small>@{user.username}</small></span>
                        <i className="fa-solid fa-arrow-up-left-from-circle" />
                      </button>)}
                    </div>
                  )}
                  <p className="field-hint">入力に合わせてユーザー候補が表示されます。</p>
                </div>
              ) : (
                <div className="qr-panel">
                  <div className="scanner-frame">
                    <video ref={videoRef} className="qr-scanner-video" muted playsInline />
                    <div className="scanner-corner top-left" /><div className="scanner-corner top-right" />
                    <div className="scanner-corner bottom-left" /><div className="scanner-corner bottom-right" />
                    <i className="fa-solid fa-qrcode scanner-watermark" />
                  </div>
                  <p className="scanner-status">{scanStatus}</p>
                  <label className="field"><span>またはユーザー名を入力</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="例: sora_01" autoCapitalize="none" maxLength={20} /></label>
                  <p className="field-hint">SoraChat のQRコードを読み取ると、ユーザー名が入力されます。</p>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="field"><span>グループ名</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} autoFocus placeholder="グループ名を入力" /></label>
              <label className="field"><span>メンバーのユーザー名（カンマ区切り、{usernames.length}人）</span><textarea value={members} onChange={(e) => setMembers(e.target.value)} rows={3} autoCapitalize="none" autoCorrect="off" placeholder="sora_01, kaito_22" /></label>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="sheet-actions">
            <button type="button" className="btn ghost" onClick={onClose}>キャンセル</button>
            <button className="btn primary" disabled={busy || !ready}>{busy ? "処理中…" : tab === "direct" ? "トークを開始" : "グループを作成"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
