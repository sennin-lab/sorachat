import { useState } from "react";
import { Avatar } from "./Avatar";
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
      <div className="sheet forward-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title-row">
          <h2>ほかの人に送信</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        <input className="fwd-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" />
        <ul className="fwd-list">
          {list.map((c) => (
            <li key={c.id}>
              <button onClick={() => onPick(c.id)}>
                <Avatar userId={c.isGroup ? "" : c.otherId ?? ""} hasAvatar={c.hasAvatar} name={c.name} size={36} />
                <span>{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {!list.length && <p className="muted">送信先がありません。</p>}
      </div>
    </div>
  );
}
