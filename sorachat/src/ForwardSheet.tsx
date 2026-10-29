import { useState } from "react";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import type { Conversation } from "./types";

export function ForwardSheet({
  conversations,
  onPick,
  onClose
}: {
  conversations: Conversation[];
  onPick: (conversationId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const list = conversations.filter((c) => c.name.toLowerCase().includes(keyword));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="送信先" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title-row">
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            <Icon name="close" size={22} />
          </button>
          <strong>送信先</strong>
          <span />
        </div>
        <input className="search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" />
        <ul className="user-list">
          {list.map((c) => (
            <li key={c.id}>
              <button onClick={() => onPick(c.id)}>
                <Avatar userId={c.isGroup ? "" : c.otherId ?? ""} hasAvatar={c.hasAvatar} name={c.name} size={44} />
                <span className="user-text">
                  <strong>{c.name}</strong>
                </span>
                <span className="send-chip">送信</span>
              </button>
            </li>
          ))}
        </ul>
        {!list.length && <p className="muted center">送信先がありません。</p>}
      </div>
    </div>
  );
}
