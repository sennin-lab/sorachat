import { useEffect, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import type { Conversation } from "./types";

type User = { id: string; username: string; displayName: string; hasAvatar: boolean };

// 連絡先（SoraChatのユーザー）を選んで送る。最近のトークと、ユーザー名での検索から選べる
export function ContactSheet({
  conversations,
  meId,
  onPick,
  onClose
}: {
  conversations: Conversation[];
  meId: string;
  onPick: (username: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<User[]>([]);
  const keyword = query.trim().toLowerCase();

  useEffect(() => {
    if (!keyword) {
      setResults([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api<User[]>(`/api/users/suggest?q=${encodeURIComponent(keyword)}`)
        .then((items) => alive && setResults(items.filter((u) => u.id !== meId)))
        .catch(() => alive && setResults([]));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [keyword, meId]);

  const friends = conversations.filter((c) => !c.isGroup && c.otherUsername);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet contact-sheet" role="dialog" aria-label="連絡先を選択" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title-row">
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            <Icon name="close" size={22} />
          </button>
          <strong>連絡先を送信</strong>
          <span />
        </div>
        <input className="search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ユーザー名で検索" autoCapitalize="none" />
        <ul className="user-list">
          {(keyword ? results : friends).map((u) => {
            const isConv = !keyword;
            const user = isConv
              ? { id: (u as Conversation).otherId ?? "", username: (u as Conversation).otherUsername ?? "", displayName: (u as Conversation).name, hasAvatar: (u as Conversation).hasAvatar }
              : (u as User);
            return (
              <li key={user.id || user.username}>
                <button onClick={() => onPick(user.username)}>
                  <Avatar userId={user.id} hasAvatar={user.hasAvatar} name={user.displayName} size={44} />
                  <span className="user-text">
                    <strong>{user.displayName}</strong>
                    <small>{user.username}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {keyword && !results.length && <p className="muted center">見つかりませんでした。</p>}
        {!keyword && !friends.length && <p className="muted center">ユーザー名で検索してください。</p>}
      </div>
    </div>
  );
}
