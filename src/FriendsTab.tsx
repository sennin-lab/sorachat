import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { UserRow } from "./UserRow";
import type { Friend, Me } from "./types";

// 「友だち」タブ：自分のプロフィール、友だち一覧（検索つき）
export function FriendsTab({
  me,
  onOpenMe,
  onOpenUser,
  onAdd,
  version = 0
}: {
  me: Me;
  onOpenMe: () => void;
  onOpenUser: (id: string) => void;
  onAdd: () => void;
  version?: number;
}) {
  const [items, setItems] = useState<Friend[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<Friend[]>("/api/friends")
      .then((next) => {
        setItems(next);
        setError("");
      })
      .catch(() => setError("友だちを読み込めませんでした。"));
  }, [version]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!items) return [];
    if (!q) return items;
    return items.filter((f) => f.displayName.toLowerCase().includes(q) || f.username.includes(q));
  }, [items, query]);

  return (
    <div className="tab-panel" key="friends">
      <header className="tab-head">
        <strong className="tab-title">友だち</strong>
        <button className="icon-btn" onClick={onAdd} aria-label="友だちを追加">
          <Icon name="userPlus" size={24} />
        </button>
      </header>

      <div className="search-bar">
        <label className="search-field">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="友だちを検索" />
        </label>
      </div>

      <ul className="user-list-ul">
        <li className="user-li" style={{ "--i": 0 } as CSSProperties}>
          <button className="user-row me-row" onClick={onOpenMe}>
            <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={me.displayName} size={50} />
            <span className="row-text">
              <strong>{me.displayName}</strong>
              <small>{me.bio || "ステータスメッセージを設定しよう"}</small>
            </span>
          </button>
        </li>
      </ul>

      {items && (
        <div className="section-label">
          <span>友だち</span>
          <span className="section-count">{items.length}</span>
        </div>
      )}

      {error && <p className="notice error center">{error}</p>}

      {items && !items.length && (
        <div className="tab-empty">
          <p>まだ友だちがいません。</p>
          <button className="btn-primary" onClick={onAdd}>
            友だちを追加
          </button>
        </div>
      )}

      {items && items.length > 0 && !shown.length && <p className="muted center pad">見つかりませんでした。</p>}

      {shown.length > 0 && (
        <ul className="user-list-ul">
          {shown.map((f, i) => (
            <UserRow
              key={f.id}
              index={i + 1}
              userId={f.id}
              hasAvatar={f.hasAvatar}
              name={f.displayName}
              sub={f.bio || `@${f.username}`}
              onClick={() => onOpenUser(f.id)}
            />
          ))}
        </ul>
      )}

      {!items && !error && (
        <ul className="skeleton-list" aria-label="読み込み中">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="skeleton-row" />
          ))}
        </ul>
      )}
    </div>
  );
}
