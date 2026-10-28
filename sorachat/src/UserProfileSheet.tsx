import { useEffect, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { calls } from "./call";
import type { UserProfile } from "./types";

export function UserProfileSheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<UserProfile>(`/api/users/${userId}/profile`)
      .then(setProfile)
      .catch(() => setFailed(true));
  }, [userId]);

  return (
    <div className="line-screen" role="dialog">
      <header className="line-bar">
        <button onClick={onClose} aria-label="閉じる">
          ‹
        </button>
        <strong>プロフィール</strong>
        <span />
      </header>
      {failed && <p className="error">プロフィールを読み込めませんでした。</p>}
      {profile && (
        <>
          <div className="line-hero">
            <Avatar userId={profile.id} hasAvatar={profile.hasAvatar} name={profile.displayName} size={96} />
            <h2>{profile.displayName}</h2>
            <p className="sub">@{profile.username}</p>
            {profile.bio && <p className="bio">{profile.bio}</p>}
          </div>
          {profile.note && (
            <div className="line-note">
              <span className="note-tag">ノート</span>
              <span>{profile.note}</span>
            </div>
          )}
          <div className="line-btn-row">
            <button className="round-action" onClick={onClose}>
              <span className="round-icon">💬</span>
              トーク
            </button>
            <button
              className="round-action"
              onClick={() => calls.start({ id: profile.id, name: profile.displayName, hasAvatar: profile.hasAvatar })}
            >
              <span className="round-icon">📞</span>
              通話
            </button>
          </div>
        </>
      )}
    </div>
  );
}
