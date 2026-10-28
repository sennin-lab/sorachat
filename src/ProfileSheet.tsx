import { useEffect, useState, type ChangeEvent } from "react";
import { ApiError, api, patch, post, put } from "./api";
import { Avatar } from "./Avatar";
import { disablePush, enablePush } from "./push";
import type { Me } from "./types";

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

type Note = { body: string; expiresAt: string } | null;

export function ProfileSheet({
  me,
  onClose,
  onChange,
  onLogout
}: {
  me: Me;
  onClose: () => void;
  onChange: (me: Me) => void;
  onLogout: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(me.displayName);
  const [username, setUsername] = useState(me.username);
  const [bio, setBio] = useState(me.bio);
  const [note, setNote] = useState<Note>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [notifyDm, setNotifyDm] = useState(me.notifyDm);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Note>("/api/me/note").then(setNote).catch(() => undefined);
  }, []);

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
      const next = await api<Me>("/api/me", patch({ displayName, username: username.trim().toLowerCase(), bio }));
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
      return "ノートを更新しました。";
    });

  const toggleNotify = (on: boolean) =>
    run(async () => {
      setNotifyDm(on);
      onChange(await api<Me>("/api/me", patch({ notifyDm: on })));
      if (on) return enablePush();
      await disablePush();
      return "通知をオフにしました。";
    });

  const uploadAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    run(async () => {
      const form = new FormData();
      form.append("file", file);
      onChange(await api<Me>("/api/me/avatar", { method: "POST", body: form }));
      return "プロフィール画像を変更しました。";
    });
  };

  const logout = async () => {
    await api("/api/auth/logout", post()).catch(() => undefined);
    onLogout();
  };

  return (
    <div className="line-screen" role="dialog">
      <header className="line-bar">
        <button onClick={onClose} aria-label="閉じる">
          ‹
        </button>
        <strong>プロフィール</strong>
        <span />
      </header>

      <div className="line-hero">
        <label className="avatar-edit" aria-label="画像を変更">
          <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={displayName} size={96} />
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={uploadAvatar} />
        </label>
        <h2>{displayName}</h2>
        <p className="sub">@{username}</p>
        <p className="bio">{bio || "ステータスメッセージを設定しましょう"}</p>
        {me.sennin && <p className="sub small">仙人アカウント連携中</p>}
      </div>

      {noteDraft !== null ? (
        <div className="line-note editing">
          <span className="note-tag">ノート</span>
          <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} maxLength={60} autoFocus />
          <button className="line-mini" disabled={busy} onClick={saveNote}>
            保存
          </button>
        </div>
      ) : (
        <button className="line-note" onClick={() => setNoteDraft(note?.body ?? "")}>
          <span className="note-tag">ノート</span>
          <span className={note ? "" : "muted"}>{note ? note.body : "24時間で消えるノートを書く"}</span>
        </button>
      )}

      {editing ? (
        <div className="line-card">
          <div className="line-form">
            <label className="field">
              <span>表示名</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} />
            </label>
            <label className="field">
              <span>ユーザー名</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" maxLength={20} />
            </label>
            <label className="field">
              <span>ステータスメッセージ</span>
              <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200} rows={2} />
            </label>
            <div className="line-btn-inline">
              <button className="line-plain" onClick={() => setEditing(false)}>
                キャンセル
              </button>
              <button className="line-primary" disabled={busy} onClick={save}>
                保存
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="line-card">
          <button className="line-row" onClick={() => setEditing(true)}>
            プロフィールを編集
            <span className="chev">›</span>
          </button>
          <label className="line-row">
            新着トークを通知
            <input
              className="switch"
              type="checkbox"
              checked={notifyDm}
              disabled={busy}
              onChange={(e) => toggleNotify(e.target.checked)}
            />
          </label>
        </div>
      )}

      <div className="line-card">
        <button className="line-row danger" onClick={logout}>
          ログアウト
        </button>
      </div>

      {status && <p className="notice center">{status}</p>}
      <div className="bottom-space" />
    </div>
  );
}
