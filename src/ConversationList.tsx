import { useMemo, useState, type CSSProperties } from "react";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { formatTime } from "./format";
import type { Conversation } from "./types";

const previewOf = (c: Conversation) => {
  if (!c.lastPreview) return "";
  return c.lastFromMe ? `あなた: ${c.lastPreview}` : c.lastPreview;
};

// トークの一覧（LINE のトーク一覧のように、アイコン・名前・最後のメッセージ・未読数を並べる）
export function ConversationList({
  list,
  selectedId,
  onSelect,
  onCompose
}: {
  list: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCompose: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.name.toLowerCase().includes(q) || (c.otherUsername ?? "").toLowerCase().includes(q));
  }, [list, query]);

  return (
    <div className="tab-panel" key="talk">
      <header className="tab-head">
        <strong className="tab-title">トーク</strong>
        <button className="icon-btn" onClick={onCompose} aria-label="新規トーク">
          <Icon name="compose" size={23} />
        </button>
      </header>

      <div className="search-bar">
        <label className="search-field">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="トークを検索" />
        </label>
      </div>

      {!list.length && (
        <div className="tab-empty">
          <p>まだトークはありません。</p>
          <button className="btn-primary" onClick={onCompose}>
            新規トーク
          </button>
        </div>
      )}
      {list.length > 0 && !shown.length && <p className="muted center pad">見つかりませんでした。</p>}

      {shown.length > 0 && (
        <ul className="convs">
          {shown.map((c, i) => (
            <li key={c.id} className="conv-li" style={{ "--i": Math.min(i, 14) } as CSSProperties}>
              <button
                className={`conv ${c.id === selectedId ? "active" : ""} ${c.unread > 0 ? "unread" : ""}`}
                onClick={() => onSelect(c.id)}
                aria-label={c.unread > 0 ? `${c.name}（未読 ${c.unread}件）` : c.name}
              >
                <Avatar
                  userId={c.isGroup ? "" : c.otherId ?? ""}
                  hasAvatar={c.hasAvatar}
                  name={c.name}
                  size={52}
                  src={c.isGroup ? `/api/dm/${c.id}/avatar` : undefined}
                />
                <span className="conv-body">
                  <span className="conv-top">
                    <strong>
                      {c.name}
                      {c.isGroup && <span className="group-count"> {c.memberCount}</span>}
                    </strong>
                    <time>{formatTime(c.lastMessageAt)}</time>
                  </span>
                  <span className="conv-bottom">
                    <span className="preview">{previewOf(c)}</span>
                    {c.unread > 0 && (
                      <span className="badge-count" key={c.unread}>
                        {c.unread > 99 ? "99+" : c.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
