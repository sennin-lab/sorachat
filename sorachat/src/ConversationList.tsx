import { useState } from "react";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { formatTime } from "./format";
import type { Conversation } from "./types";

const previewOf = (c: Conversation) => {
  if (!c.lastPreview) return "";
  return c.lastFromMe ? `あなた: ${c.lastPreview}` : c.lastPreview;
};

export function ConversationList({
  list,
  selectedId,
  onSelect
}: {
  list: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? list.filter((c) => c.name.toLowerCase().includes(q) || (c.otherUsername ?? "").toLowerCase().includes(q))
    : list;

  return (
    <>
      <div className="dm-search">
        <label className="dm-search-field">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="検索"
            aria-label="トークを検索"
          />
        </label>
      </div>
      {!list.length && <p className="muted pad">まだトークはありません。右上の ✎ から始めましょう。</p>}
      {list.length > 0 && !shown.length && <p className="muted pad">見つかりませんでした。</p>}
      {shown.length > 0 && (
        <ul className="convs">
          {shown.map((c) => (
            <li key={c.id}>
              <button
                className={`conv ${c.id === selectedId ? "active" : ""} ${c.unread > 0 ? "unread" : ""}`}
                onClick={() => onSelect(c.id)}
                aria-label={c.unread > 0 ? `${c.name}（未読 ${c.unread}件）` : c.name}
              >
                <Avatar userId={c.isGroup ? "" : c.otherId ?? ""} hasAvatar={c.hasAvatar} name={c.name} />
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
                    {c.unread > 0 && <span className="badge" aria-hidden="true" />}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
