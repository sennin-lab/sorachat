import { Avatar } from "./Avatar";
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
  if (!list.length) {
    return <p className="muted pad">まだトークはありません。＋から始めましょう。</p>;
  }
  return (
    <ul className="convs">
      {list.map((c) => (
        <li key={c.id}>
          <button className={`conv ${c.id === selectedId ? "active" : ""}`} onClick={() => onSelect(c.id)}>
            <Avatar
              userId={c.isGroup ? "" : c.otherId ?? ""}
              hasAvatar={c.hasAvatar}
              name={c.name}
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
                {c.unread > 0 && <span className="badge">{c.unread > 99 ? "99+" : c.unread}</span>}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
