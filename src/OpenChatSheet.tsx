import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";

type OpenChat = {
  id: string;
  title: string;
  description: string;
  hasAvatar: boolean;
  memberCount: number;
  joined: boolean;
};

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

// オープンチャット: 友だちでなくても、一覧から誰でも参加できるグループ
export function OpenChatSheet({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const [chats, setChats] = useState<OpenChat[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<OpenChat[]>("/api/open-chats")
      .then(setChats)
      .catch((err) => setStatus(messageOf(err)));

  useEffect(() => {
    void load();
  }, []);

  const join = async (chat: OpenChat) => {
    if (chat.joined) {
      onOpen(chat.id);
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      await api(`/api/open-chats/${chat.id}/join`, post());
      onOpen(chat.id);
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const result = await api<{ id: string }>("/api/open-chats", post({ title: title.trim(), description: description.trim() }));
      onOpen(result.id);
    } catch (err) {
      setStatus(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" role="dialog" aria-label="オープンチャット">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>オープンチャット</strong>
        <span />
      </header>

      {creating ? (
        <form className="open-form" onSubmit={create}>
          <input className="auth-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} placeholder="名前（40文字まで）" />
          <textarea
            className="auth-input open-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            rows={3}
            placeholder="説明（200文字まで）"
          />
          {status && <p className="notice error center">{status}</p>}
          <button className="btn-primary wide" disabled={busy || !title.trim()}>
            作成して入る
          </button>
          <button type="button" className="btn-text" onClick={() => setCreating(false)}>
            やめる
          </button>
        </form>
      ) : (
        <>
          <div className="action-row">
            <button className="btn-secondary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={18} /> オープンチャットを作る
            </button>
          </div>
          {status && <p className="notice error center">{status}</p>}
          {!chats ? (
            <p className="notice center">読み込み中…</p>
          ) : chats.length === 0 ? (
            <p className="notice center">まだオープンチャットがありません。作ってみましょう。</p>
          ) : (
            <ul className="open-list">
              {chats.map((chat) => (
                <li key={chat.id} className="open-item">
                  <Avatar userId="" hasAvatar={false} name={chat.title} size={48} />
                  <span className="open-text">
                    <strong>{chat.title}</strong>
                    {chat.description && <small>{chat.description}</small>}
                    <small className="muted">{chat.memberCount}人</small>
                  </span>
                  <button className={chat.joined ? "btn-small" : "btn-small accent"} disabled={busy} onClick={() => void join(chat)}>
                    {chat.joined ? "開く" : "参加"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
