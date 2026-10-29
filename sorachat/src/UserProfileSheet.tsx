import { useEffect, useState } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";
import { calls } from "./call";
import { Cover } from "./Cover";
import { Icon } from "./Icon";
import type { UserProfile } from "./types";

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

// 相手のプロフィール。友だちの追加・削除、メッセージ、通話をここから行う
export function UserProfileSheet({
  userId,
  onClose,
  onMessage,
  onFriendsChanged
}: {
  userId: string;
  onClose: () => void;
  // 指定があれば「メッセージ」でそのトークを開く（なければ閉じるだけ）
  onMessage?: (username: string) => void;
  onFriendsChanged?: () => void;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<UserProfile>(`/api/users/${userId}/profile`).then(setProfile).catch(() => setFailed(true));
  }, [userId]);

  const addFriend = async () => {
    if (!profile) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/friends", post({ username: profile.username }));
      setProfile({ ...profile, isFriend: true });
      onFriendsChanged?.();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const removeFriend = async () => {
    if (!profile) return;
    if (!window.confirm(`${profile.displayName} さんを友だちから削除しますか？`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/friends/${profile.id}`, { method: "DELETE" });
      setProfile({ ...profile, isFriend: false });
      onFriendsChanged?.();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page profile-page" role="dialog" aria-label="プロフィール">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>{profile?.displayName ?? ""}</strong>
        <span />
      </header>
      {failed && <p className="notice center error">プロフィールを読み込めませんでした。</p>}
      {!profile && !failed && <p className="notice center">読み込み中…</p>}
      {profile && (
        <>
          <div className="profile-top">
            <Cover theme={profile.coverTheme} />
            <div className="profile-avatar static">
              <Avatar userId={profile.id} hasAvatar={profile.hasAvatar} name={profile.displayName} size={104} />
            </div>
            <strong className="profile-name">{profile.displayName}</strong>
            <p className={`profile-status ${profile.bio ? "" : "muted"}`}>{profile.bio || "ステータスメッセージはありません"}</p>
          </div>

          {profile.note && (
            <div className="note">
              <span className="note-tag">ノート</span>
              <span>{profile.note}</span>
            </div>
          )}

          <div className="profile-actions wide-actions">
            {onMessage ? (
              <button className="pill primary" onClick={() => onMessage(profile.username)}>
                <Icon name="chat" size={18} /> トーク
              </button>
            ) : (
              <button className="pill primary" onClick={onClose}>
                <Icon name="chat" size={18} /> トーク
              </button>
            )}
            <button
              className="pill"
              onClick={() => calls.start({ id: profile.id, name: profile.displayName, hasAvatar: profile.hasAvatar })}
            >
              <Icon name="phone" size={18} /> 通話
            </button>
          </div>

          {(profile.contact || profile.profileUrl) && (
            <div className="page-card">
              {profile.contact && (
                <div className="page-row static">
                  <span className="muted">連絡先</span>
                  <span>{profile.contact}</span>
                </div>
              )}
              {profile.profileUrl && (
                <a className="page-row static link-row" href={profile.profileUrl} target="_blank" rel="noreferrer">
                  <span className="muted">リンク</span>
                  <span className="link">{profile.profileUrl}</span>
                </a>
              )}
            </div>
          )}

          <div className="page-card">
            {profile.isFriend ? (
              <button className="page-row danger" disabled={busy} onClick={() => void removeFriend()}>
                <Icon name="trash" size={18} /> 友だちから削除
              </button>
            ) : (
              <button className="page-row accent" disabled={busy} onClick={() => void addFriend()}>
                <Icon name="userPlus" size={18} /> {busy ? "追加中…" : "友だちに追加"}
              </button>
            )}
          </div>

          {error && <p className="notice center error shake">{error}</p>}
        </>
      )}
    </div>
  );
}
