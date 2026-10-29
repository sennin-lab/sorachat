import { useEffect, useState, type ChangeEvent } from "react";
import { ApiError, api, patch, put } from "./api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { makeQrImage, profileQrValue } from "./qr";
import { SettingsSheet } from "./SettingsSheet";
import type { Me } from "./types";

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

type Note = { body: string; expiresAt: string } | null;

export function ProfileSheet({
  me,
  theme,
  onThemeChange,
  onClose,
  onChange,
  onLogout
}: {
  me: Me;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onClose: () => void;
  onChange: (me: Me) => void;
  onLogout: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const [displayName, setDisplayName] = useState(me.displayName);
  const [username, setUsername] = useState(me.username);
  const [bio, setBio] = useState(me.bio);
  const [contact, setContact] = useState(me.contact ?? "");
  const [profileUrl, setProfileUrl] = useState(me.profileUrl ?? "");
  const [note, setNote] = useState<Note>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Note>("/api/me/note").then(setNote).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (showQr) makeQrImage(profileQrValue(me.username)).then(setQrImage).catch(() => setQrImage(""));
  }, [showQr, me.username]);

  const run = async (task: () => Promise<string>) => {
    setBusy(true);
    setStatus("");
    try {
      setStatus(await task());
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const next = await api<Me>(
        "/api/me",
        patch({ displayName, username: username.trim().toLowerCase(), bio, contact: contact.trim(), profileUrl: profileUrl.trim() })
      );
      onChange(next);
      setUsername(next.username);
      setEditing(false);
      return "保存しました。";
    });

  const saveNote = () =>
    run(async () => {
      const body = (noteDraft ?? "").trim();
      if (!body) {
        await api("/api/me/note", { method: "DELETE" });
        setNote(null);
      } else {
        setNote(await api<Note>("/api/me/note", put({ body })));
      }
      setNoteDraft(null);
      return "";
    });

  const uploadAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void run(async () => {
      const form = new FormData();
      form.append("file", file);
      onChange(await api<Me>("/api/me/avatar", { method: "POST", body: form }));
      return "";
    });
  };

  if (showSettings) {
    return (
      <SettingsSheet
        me={me}
        theme={theme}
        onThemeChange={onThemeChange}
        onChange={onChange}
        onClose={() => setShowSettings(false)}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div className="page" role="dialog" aria-label="プロフィール">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>{me.username}</strong>
        <button onClick={() => setShowSettings(true)} aria-label="設定">
          <Icon name="settings" size={24} />
        </button>
      </header>

      <div className="page-hero">
        <label className="avatar-edit" aria-label="プロフィール画像を変更">
          <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={displayName} size={86} />
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={uploadAvatar} />
        </label>
        <strong className="hero-name">{displayName}</strong>
        {bio && <p className="bio">{bio}</p>}
        {me.sennin && <p className="muted small">仙人アカウント連携中</p>}
      </div>

      <div className="action-row">
        <button className="btn-secondary" onClick={() => setEditing((v) => !v)}>
          プロフィールを編集
        </button>
        <button className="btn-secondary" onClick={() => setShowQr((v) => !v)}>
          <Icon name="qr" size={18} /> QRコード
        </button>
      </div>

      {showQr && (
        <div className="qr-card">
          {qrImage && <img src={qrImage} alt={`${me.username} のQRコード`} />}
          <span className="muted">{me.username}</span>
          <p className="muted small">相手がこのQRコードを読み取ると、トークを始められます。</p>
        </div>
      )}

      {noteDraft !== null ? (
        <div className="note editing">
          <span className="note-tag">ノート</span>
          <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} maxLength={60} autoFocus />
          <button className="btn-small" disabled={busy} onClick={saveNote}>
            保存
          </button>
        </div>
      ) : (
        <button className="note" onClick={() => setNoteDraft(note?.body ?? "")}>
          <span className="note-tag">ノート</span>
          <span className={note ? "" : "muted"}>{note ? note.body : "ノートを書く（24時間で消えます）"}</span>
        </button>
      )}

      {editing && (
        <div className="page-form">
          <label className="field">
            <span>名前</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} />
          </label>
          <label className="field">
            <span>ユーザー名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" maxLength={20} />
          </label>
          <label className="field">
            <span>自己紹介</span>
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200} rows={2} />
          </label>
          <label className="field">
            <span>連絡先</span>
            <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} />
          </label>
          <label className="field">
            <span>リンク</span>
            <input value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} maxLength={200} inputMode="url" placeholder="https://" />
          </label>
          <div className="btn-inline">
            <button className="btn-text" onClick={() => setEditing(false)}>
              キャンセル
            </button>
            <button className="btn-primary" disabled={busy} onClick={save}>
              保存
            </button>
          </div>
        </div>
      )}

      {status && <p className="notice center">{status}</p>}
    </div>
  );
}
