import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Icon } from "./Icon";
import { UserRow } from "./UserRow";
import type { Friend } from "./types";

// 連絡先（友だち）を選んで送る
export function ContactSheet({
  meId,
  onPick,
  onClose
}: {
  meId: string;
  onPick: (username: string) => void;
  onClose: () => void;
}) {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api<Friend[]>("/api/friends")
      .then((items) => setFriends(items.filter((f) => f.id !== meId)))
      .catch(() => setFriends([]));
  }, [meId]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (friends ?? []).filter((f) => !q || f.displayName.toLowerCase().includes(q) || f.username.includes(q));
  }, [friends, query]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet contact-sheet" role="dialog" aria-label="連絡先を選択" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title-row">
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            <Icon name="close" size={22} />
          </button>
          <strong>連絡先を送信</strong>
          <span />
        </div>
        <div className="search-bar">
          <label className="search-field">
            <Icon name="search" size={16} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="友だちを検索" />
          </label>
        </div>
        <ul className="user-list-ul">
          {shown.map((f, i) => (
            <UserRow key={f.id} index={i} userId={f.id} hasAvatar={f.hasAvatar} name={f.displayName} sub={`@${f.username}`} onClick={() => onPick(f.username)} />
          ))}
        </ul>
        {friends && !shown.length && <p className="muted center pad">{friends.length ? "見つかりませんでした。" : "友だちがいません。"}</p>}
      </div>
    </div>
  );
}
