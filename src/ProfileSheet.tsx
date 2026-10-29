import { useEffect, useState, type ChangeEvent } from "react";
import { AvatarCropper } from "./AvatarCropper";
import { ApiError, api, patch, put } from "./api";
import { Avatar } from "./Avatar";
import { COVER_THEMES, Cover } from "./Cover";
import { Icon } from "./Icon";
import { makeQrImage, profileQrValue } from "./qr";
import { SettingsSheet } from "./SettingsSheet";
import type { CoverTheme, Me } from "./types";

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

type Note = { body: string; expiresAt: string } | null;

// 自分のプロフィール（LINE のプロフィール画面のように、背景・アバター・ステータスメッセージを表示する）
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
  const [showCovers, setShowCovers] = useState(false);
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
  const [cropSource, setCropSource] = useState<string | null>(null);

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

  const chooseCover = (id: CoverTheme) =>
    run(async () => {
      if (id === me.coverTheme) return "";
      onChange(await api<Me>("/api/me", patch({ coverTheme: id })));
      return "";
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
    if (!file.type.startsWith("image/")) {
      setStatus("画像ファイルを選択してください。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setCropSource(reader.result);
    };
    reader.onerror = () => setStatus("画像を読み込めませんでした。");
    reader.readAsDataURL(file);
  };

  const saveCroppedAvatar = async (blob: Blob) => {
    setCropSource(null);
    await run(async () => {
      const form = new FormData();
      form.append("file", blob, "profile.jpg");
      onChange(await api<Me>("/api/me/avatar", { method: "POST", body: form }));
      return "プロフィール画像を更新しました。";
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
    <div className="page profile-page" role="dialog" aria-label="プロフィール">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>プロフィール</strong>
        <button className="bar-action" onClick={() => setEditing((v) => !v)}>
          {editing ? "閉じる" : "編集"}
        </button>
      </header>

      <div className="profile-top">
        <Cover theme={me.coverTheme}>
          <button className="cover-edit" onClick={() => setShowCovers((v) => !v)} aria-label="背景を変更">
            <Icon name="camera" size={18} />
          </button>
        </Cover>
        <label className="profile-avatar" aria-label="プロフィール画像を変更">
          <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={displayName} size={104} />
          <span className="avatar-badge" aria-hidden="true">
            <Icon name="camera" size={14} />
          </span>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={uploadAvatar} />
        </label>
        <strong className="profile-name">{displayName}</strong>
        <p className={`profile-status ${bio ? "" : "muted"}`}>{bio || "ステータスメッセージを入力"}</p>
        {me.sennin && <p className="muted small">仙人アカウント連携中</p>}
      </div>

      {showCovers && (
        <div className="cover-picker" role="radiogroup" aria-label="背景">
          {COVER_THEMES.map((t, i) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={me.coverTheme === t.id}
              aria-label={t.label}
              className={`swatch ${me.coverTheme === t.id ? "on" : ""}`}
              style={{ background: `linear-gradient(135deg, ${t.from}, ${t.to})`, animationDelay: `${i * 40}ms` }}
              disabled={busy}
              onClick={() => void chooseCover(t.id)}
            />
          ))}
        </div>
      )}

      <div className="profile-actions">
        <button className="pill" onClick={() => setEditing(true)}>
          プロフィールを編集
        </button>
        <button className="pill" onClick={() => setShowQr((v) => !v)}>
          <Icon name="qr" size={18} /> QRコード
        </button>
        <button className="pill" onClick={() => setShowSettings(true)}>
          <Icon name="settings" size={18} /> 設定
        </button>
      </div>

      {showQr && (
        <div className="qr-card">
          {qrImage && <img src={qrImage} alt={`${me.username} のQRコード`} />}
          <span className="muted">@{me.username}</span>
          <p className="muted small">相手がこのQRコードを読み取ると、友だちに追加できます。</p>
        </div>
      )}

      {noteDraft !== null ? (
        <div className="note editing">
          <span className="note-tag">ノート</span>
          <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} maxLength={60} autoFocus />
          <button className="btn-small accent" disabled={busy} onClick={saveNote}>
            保存
          </button>
        </div>
      ) : (
        <button className="note" onClick={() => setNoteDraft(note?.body ?? "")}>
          <span className="note-tag">ノート</span>
          <span className={note ? "" : "muted"}>{note ? note.body : "書く（24時間で消えます）"}</span>
          <Icon name="edit" size={16} className="chev" />
        </button>
      )}

      {editing && (
        <div className="page-card form-card">
          <label className="form-row">
            <span>名前</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} />
          </label>
          <label className="form-row">
            <span>ユーザー名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" maxLength={20} />
          </label>
          <label className="form-row">
            <span>ステータス</span>
            <input value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200} placeholder="ひとこと" />
          </label>
          <label className="form-row">
            <span>連絡先</span>
            <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} />
          </label>
          <label className="form-row">
            <span>リンク</span>
            <input value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} maxLength={200} inputMode="url" placeholder="https://" />
          </label>
          <div className="btn-inline form-foot">
            <button className="btn-text" onClick={() => setEditing(false)}>
              キャンセル
            </button>
            <button className="btn-primary" disabled={busy} onClick={save}>
              保存
            </button>
          </div>
        </div>
      )}

      {cropSource && (
        <AvatarCropper
          source={cropSource}
          onCancel={() => setCropSource(null)}
          onSave={(blob) => void saveCroppedAvatar(blob)}
        />
      )}
      {status && <p className="notice center">{status}</p>}
    </div>
  );
}
