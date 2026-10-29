import { useEffect, useState } from "react";
import { ApiError, api, patch, post } from "./api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import type { Member } from "./types";

type Detail = { id: string; isGroup: boolean; title: string; myRole: "owner" | "member"; members: Member[] };

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
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState("");
  const [status, setStatus] = useState("");

  const load = async () => {
    const next = await api<Detail>(`/api/dm/${conversationId}`);
    setDetail(next);
    setTitle(next.title);
  };

  useEffect(() => {
    load().catch((err) => setStatus(messageOf(err)));
  }, [conversationId]);

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

  if (!detail) {
    return (
      <div className="sheet-backdrop" onClick={onClose}>
        <div className="sheet">{status || "読み込み中…"}</div>
      </div>
    );
  }

  const isOwner = detail.myRole === "owner";

  return (
    <div className="page" role="dialog">
      <header className="page-bar">
        <button onClick={onClose} aria-label="閉じる">
          <Icon name="back" size={26} />
        </button>
        <strong>グループ情報</strong>
        <span />
      </header>
      <div className="page-hero">
        <Avatar userId="" hasAvatar={false} name={detail.title} size={96} />
        {isOwner ? (
          <div className="inline-edit">
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} />
            <button
              className="btn-small"
              onClick={() => run(() => api(`/api/dm/${conversationId}`, patch({ title: title.trim() })).then(() => undefined), "グループ名を変更しました。")}
            >
              変更
            </button>
          </div>
        ) : (
          <h2>{detail.title}</h2>
        )}
        <p className="sub">{detail.members.length}人のメンバー</p>
      </div>

      <div className="page-card">
        <div className="page-form">
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="追加するユーザー名（カンマ区切り）"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button
            className="btn-primary"
            disabled={!adding.trim()}
            onClick={() =>
              run(async () => {
                const usernames = adding.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
                await api(`/api/dm/${conversationId}/members`, post({ usernames }));
                setAdding("");
              }, "メンバーを追加しました。")
            }
          >
            メンバーを追加
          </button>
        </div>
        {detail.members.map((m) => (
          <div className="page-row member" key={m.id}>
            <Avatar userId={m.id} hasAvatar={m.hasAvatar} name={m.displayName} size={40} />
            <span className="member-name">
              {m.displayName}
              {m.id === meId && <span className="muted small"> （自分）</span>}
              {m.role === "owner" && <span className="owner-tag">管理者</span>}
              <span className="muted small block">@{m.username}</span>
            </span>
            {isOwner && m.id !== meId && (
              <button
                className="btn-small danger"
                onClick={() => run(() => api(`/api/dm/${conversationId}/members/${m.id}`, { method: "DELETE" }).then(() => undefined), "削除しました。")}
              >
                削除
              </button>
            )}
          </div>
        ))}
      </div>

      {status && <p className="notice center">{status}</p>}

      <div className="page-card">
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
