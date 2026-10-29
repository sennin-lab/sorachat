import { useEffect, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { calls } from "./call";
import { Icon } from "./Icon";
import type { UserProfile } from "./types";

export function UserProfileSheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<UserProfile>(`/api/users/${userId}/profile`).then(setProfile).catch(() => setFailed(true));
  }, [userId]);

  return (
    <div className="page" role="dialog" aria-label="プロフィール">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>{profile?.username ?? ""}</strong>
        <span />
      </header>
      {failed && <p className="notice center error">プロフィールを読み込めませんでした。</p>}
      {profile && (
        <>
          <div className="page-hero">
            <Avatar userId={profile.id} hasAvatar={profile.hasAvatar} name={profile.displayName} size={86} />
            <strong className="hero-name">{profile.displayName}</strong>
            {profile.bio && <p className="bio">{profile.bio}</p>}
            {profile.contact && <p className="muted small">{profile.contact}</p>}
            {profile.profileUrl && (
              <a className="small link" href={profile.profileUrl} target="_blank" rel="noreferrer">
                {profile.profileUrl}
              </a>
            )}
          </div>
          {profile.note && (
            <div className="note">
              <span className="note-tag">ノート</span>
              <span>{profile.note}</span>
            </div>
          )}
          <div className="action-row">
            <button className="btn-primary" onClick={onClose}>
              メッセージ
            </button>
            <button
              className="btn-secondary"
              onClick={() => calls.start({ id: profile.id, name: profile.displayName, hasAvatar: profile.hasAvatar })}
            >
              通話
            </button>
          </div>
        </>
      )}
    </div>
  );
}
