import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { ApiError, api, patch, post } from "./api";
import { Avatar } from "./Avatar";
import { AvatarCropper } from "./AvatarCropper";
import { FriendSelectPage } from "./FriendSelectPage";
import { Icon } from "./Icon";
import { UserRow } from "./UserRow";
import type { Friend, Member } from "./types";

type Detail = {
  id: string;
  isGroup: boolean;
  title: string;
  hasAvatar: boolean;
  myRole: "owner" | "member";
  members: Member[];
};

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

export function GroupSheet({
  conversationId,
  meId,
  onClose,
  onLeft,
  onChanged
}: {
  conversationId: string;
  meId: string;
  onClose: () => void;
  onLeft: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // 切り抜き中の画像と、アイコンを差し替えたあとの再読み込み用の番号
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [avatarKey, setAvatarKey] = useState(0);

  const load = async () => {
    const next = await api<Detail>(`/api/dm/${conversationId}`);
    setDetail(next);
    setTitle(next.title);
  };

  useEffect(() => {
    load().catch((err) => setStatus(messageOf(err)));
    api<Friend[]>("/api/friends").then(setFriends).catch(() => setFriends([]));
  }, [conversationId]);

  const memberIds = useMemo(() => new Set((detail?.members ?? []).map((m) => m.id)), [detail]);

  // メンバーの追加：友だちの中から選んだ人だけを追加する
  const addPicked = async (picked: Friend[]) => {
    setBusy(true);
    setStatus("");
    try {
      await api(`/api/dm/${conversationId}/members`, post({ usernames: picked.map((f) => f.username) }));
      await load();
      setAdding(false);
      setStatus(`${picked.length}人を追加しました。`);
      onChanged();
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const pickAvatar = (event: ChangeEvent<HTMLInputElement>) => {
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

  const saveAvatar = async (blob: Blob) => {
    setCropSource(null);
    setBusy(true);
    setStatus("");
    try {
      const form = new FormData();
      form.append("file", blob, "group.jpg");
      await api(`/api/dm/${conversationId}/avatar`, { method: "POST", body: form });
      setAvatarKey((k) => k + 1);
      await load();
      onChanged();
      setStatus("グループのアイコンを更新しました。");
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async (task: () => Promise<void>, done: string) => {
    setStatus("");
    try {
      await task();
      await load();
      onChanged();
      if (done) setStatus(done);
    } catch (err) {
      setStatus(messageOf(err));
    }
  };

  if (adding) {
    return (
      <FriendSelectPage
        title="メンバーを追加"
        friends={friends}
        memberIds={memberIds}
        confirmLabel="追加"
        busy={busy}
        error={status}
        emptyText="追加できる友だちがいません。"
        onConfirm={(picked) => void addPicked(picked)}
        onClose={() => setAdding(false)}
      />
    );
  }

  if (!detail) {
    return (
      <div className="page" role="dialog">
        <header className="page-bar">
          <button onClick={onClose} aria-label="閉じる">
            <Icon name="back" size={26} />
          </button>
          <strong>グループ情報</strong>
          <span />
        </header>
        <p className="notice center">{status || "読み込み中…"}</p>
      </div>
    );
  }

  const isOwner = detail.myRole === "owner";

  return (
    <div className="page" role="dialog" aria-label="グループ情報">
      <header className="page-bar">
        <button onClick={onClose} aria-label="閉じる">
          <Icon name="back" size={26} />
        </button>
        <strong>グループ情報</strong>
        <span />
      </header>

      <div className="group-hero">
        {isOwner ? (
          <label className="profile-avatar group-avatar" aria-label="グループのアイコンを変更">
            <Avatar
              userId=""
              hasAvatar={detail.hasAvatar}
              name={detail.title}
              size={96}
              src={`/api/dm/${conversationId}/avatar?v=${avatarKey}`}
            />
            <span className="avatar-badge" aria-hidden="true">
              <Icon name="camera" size={14} />
            </span>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={pickAvatar} disabled={busy} />
          </label>
        ) : (
          <Avatar
            userId=""
            hasAvatar={detail.hasAvatar}
            name={detail.title}
            size={96}
            src={`/api/dm/${conversationId}/avatar?v=${avatarKey}`}
          />
        )}
        {isOwner ? (
          <div className="inline-edit">
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} aria-label="グループ名" />
            <button
              className="btn-small accent"
              onClick={() => run(() => api(`/api/dm/${conversationId}`, patch({ title: title.trim() })).then(() => undefined), "グループ名を変更しました。")}
            >
              変更
            </button>
          </div>
        ) : (
          <h2 className="hero-name">{detail.title}</h2>
        )}
        <p className="muted small">{detail.members.length}人のメンバー</p>
      </div>

      <div className="action-row">
        <button className="btn-secondary" onClick={() => setAdding(true)}>
          <Icon name="userPlus" size={18} /> メンバーを追加
        </button>
      </div>

      <div className="section-label">
        <span>メンバー</span>
        <span className="section-count">{detail.members.length}</span>
      </div>
      <ul className="user-list-ul">
        {detail.members.map((m, i) => (
          <UserRow
            key={m.id}
            index={i}
            userId={m.id}
            hasAvatar={m.hasAvatar}
            name={m.displayName}
            sub={`@${m.username}`}
            right={
              <span className="member-end">
                {m.id === meId && <span className="muted small">自分</span>}
                {m.role === "owner" && <span className="owner-tag">管理者</span>}
                {isOwner && m.id !== meId && (
                  <button
                    className="btn-small danger"
                    onClick={() => run(() => api(`/api/dm/${conversationId}/members/${m.id}`, { method: "DELETE" }).then(() => undefined), "削除しました。")}
                  >
                    削除
                  </button>
                )}
              </span>
            }
          />
        ))}
      </ul>

      {cropSource && (
        <AvatarCropper source={cropSource} onCancel={() => setCropSource(null)} onSave={(blob) => void saveAvatar(blob)} />
      )}
      {status && <p className="notice center">{status}</p>}

      <div className="page-card leave-card">
        <button
          className="page-row danger"
          onClick={async () => {
            try {
              await api(`/api/dm/${conversationId}/leave`, post());
              onChanged();
              onLeft();
            } catch (err) {
              setStatus(messageOf(err));
            }
          }}
        >
          グループを退出
        </button>
      </div>
    </div>
  );
}
