import { useEffect, useState } from "react";
import { ApiError, api, delete_, post } from "./api";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { Cover } from "./Cover";
import { Icon } from "./Icon";
import type { FriendshipState, UserProfile } from "./types";

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

// 相手のプロフィール。友だちの追加・削除、メッセージ、通話をここから行う
export function UserProfileSheet({
  userId,
  onClose,
  onMessage,
  onFriendsChanged,
  onRoomSettings
}: {
  userId: string;
  onClose: () => void;
  // 指定があれば「メッセージ」でそのトークを開く（なければ閉じるだけ）
  onMessage?: (username: string) => void;
  onFriendsChanged?: () => void;
  // 指定があれば「トークの設定」（通知・ブロック・削除）を開く（個人チャットから）
  onRoomSettings?: () => void;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // ブロック中かどうか（null は確認中）
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [askBlock, setAskBlock] = useState(false);

  useEffect(() => {
    api<UserProfile>(`/api/users/${userId}/profile`).then(setProfile).catch(() => setFailed(true));
  }, [userId]);

  useEffect(() => {
    api<{ id: string }[]>("/api/blocks")
      .then((list) => setBlocked(list.some((b) => b.id === userId)))
      .catch(() => setBlocked(false));
  }, [userId]);

  // ブロックすると友だちと申請は消え、トークは送れなくなる（サーバー側で同じことをする）
  const block = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/blocks/${userId}`, post());
      setBlocked(true);
      setAskBlock(false);
      applied("none");
    } catch (err) {
      setError(messageOf(err));
      setAskBlock(false);
    } finally {
      setBusy(false);
    }
  };

  const unblock = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/blocks/${userId}`, delete_());
      setBlocked(false);
      onFriendsChanged?.();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  // 相手の状態を更新する（申請・許可・拒否・取り消し・削除のあと）
  const applied = (next: FriendshipState) => {
    setProfile((p) => (p ? { ...p, friendship: next, isFriend: next === "friend" } : p));
    onFriendsChanged?.();
  };

  const run = async (request: () => Promise<FriendshipState>) => {
    setBusy(true);
    setError("");
    try {
      applied(await request());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  // フレンド申請を送る（相手がすでに申請していれば友だちになる）
  const sendRequest = () =>
    run(async () => {
      const result = await api<{ status: FriendshipState }>("/api/friends", post({ username: profile?.username }));
      return result.status;
    });

  const answer = (accept: boolean) =>
    run(async () => {
      await api(`/api/friends/requests/${userId}/${accept ? "accept" : "decline"}`, post());
      return accept ? "friend" : "none";
    });

  const cancelRequest = () =>
    run(async () => {
      await api(`/api/friends/requests/${userId}`, delete_());
      return "none";
    });

  const removeFriend = () => {
    if (!profile) return;
    if (!window.confirm(`${profile.displayName} さんを友だちから削除しますか？`)) return;
    void run(async () => {
      await api(`/api/friends/${profile.id}`, delete_());
      return "none";
    });
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

          {onRoomSettings && (
            <div className="page-card">
              <button className="page-row" onClick={onRoomSettings}>
                トークの設定
              </button>
            </div>
          )}

          {blocked !== true && (
          <div className="page-card">
            {profile.friendship === "friend" && (
              <button className="page-row danger" disabled={busy} onClick={removeFriend}>
                <Icon name="trash" size={18} /> 友だちから削除
              </button>
            )}
            {profile.friendship === "incoming" && (
              <>
                <button className="page-row accent" disabled={busy} onClick={() => void answer(true)}>
                  <Icon name="userPlus" size={18} /> 申請を許可する
                </button>
                <button className="page-row danger" disabled={busy} onClick={() => void answer(false)}>
                  申請を拒否する
                </button>
              </>
            )}
            {profile.friendship === "outgoing" && (
              <button className="page-row danger" disabled={busy} onClick={() => void cancelRequest()}>
                申請を取り消す（申請中）
              </button>
            )}
            {profile.friendship === "none" && (
              <button className="page-row accent" disabled={busy} onClick={() => void sendRequest()}>
                <Icon name="userPlus" size={18} /> {busy ? "送信中…" : "フレンド申請を送る"}
              </button>
            )}
          </div>
          )}

          {blocked === true && (
            <div className="page-card">
              <p className="page-row static muted">この人をブロックしています。トークは送れず、発言も表示されません。</p>
              <button className="page-row accent" disabled={busy} onClick={() => void unblock()}>
                ブロックを解除
              </button>
            </div>
          )}
          {blocked === false && (
            <div className="page-card">
              <button className="page-row danger" disabled={busy} onClick={() => setAskBlock(true)}>
                ブロックする
              </button>
            </div>
          )}

          {error && <p className="notice center error shake">{error}</p>}
          {askBlock && (
            <ConfirmDialog
              title="ブロックしますか？"
              message={`${profile.displayName} さんをブロックします。友だちから外れ、トークは送れなくなります。`}
              confirmLabel="ブロックする"
              danger
              busy={busy}
              onConfirm={() => void block()}
              onCancel={() => setAskBlock(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
