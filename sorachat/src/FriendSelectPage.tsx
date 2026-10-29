import { useMemo, useState } from "react";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { UserRow } from "./UserRow";
import type { Friend } from "./types";

// 友だちを複数選ぶ画面（グループ作成・メンバー追加で使う）。選んだ人はチップで上に並ぶ
export function FriendSelectPage({
  title,
  friends,
  memberIds,
  confirmLabel,
  showName = false,
  namePlaceholder = "",
  busy = false,
  error = "",
  emptyText,
  onConfirm,
  onClose
}: {
  title: string;
  friends: Friend[];
  // すでにメンバーの人（選べないように表示する）
  memberIds?: Set<string>;
  confirmLabel: string;
  showName?: boolean;
  namePlaceholder?: string;
  busy?: boolean;
  error?: string;
  emptyText: string;
  onConfirm: (picked: Friend[], name: string) => void;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");

  const byId = useMemo(() => new Map(friends.map((f) => [f.id, f])), [friends]);
  const picked = order.map((id) => byId.get(id)).filter((f): f is Friend => Boolean(f));

  const toggle = (id: string) =>
    setOrder((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const q = query.trim().toLowerCase();
  const shown = friends.filter((f) => !q || f.displayName.toLowerCase().includes(q) || f.username.includes(q));

  return (
    <div className="page" role="dialog" aria-label={title}>
      <header className="page-bar">
        <button onClick={onClose} aria-label="閉じる">
          <Icon name="back" size={26} />
        </button>
        <strong>{title}</strong>
        <button
          className="bar-action"
          disabled={busy || picked.length === 0}
          onClick={() => onConfirm(picked, name.trim())}
        >
          {busy ? "…" : confirmLabel}
        </button>
      </header>

      {showName && (
        <div className="name-field">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder={namePlaceholder || "グループ名（未入力なら自動）"}
            aria-label="グループ名"
          />
        </div>
      )}

      <div className={`chip-strip ${picked.length ? "has" : ""}`} aria-live="polite">
        {picked.map((f) => (
          <button key={f.id} className="pick-chip" onClick={() => toggle(f.id)} aria-label={`${f.displayName}を外す`}>
            <Avatar userId={f.id} hasAvatar={f.hasAvatar} name={f.displayName} size={24} />
            <span>{f.displayName}</span>
            <Icon name="close" size={14} />
          </button>
        ))}
        {!picked.length && <span className="muted small chip-hint">友だちを選んでください</span>}
      </div>

      <div className="search-bar">
        <label className="search-field">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="友だちを検索" />
        </label>
      </div>

      {!friends.length && <p className="muted center pad">{emptyText}</p>}
      {friends.length > 0 && !shown.length && <p className="muted center pad">見つかりませんでした。</p>}

      <ul className="user-list-ul">
        {shown.map((f, i) => {
          const isMember = memberIds?.has(f.id) ?? false;
          return (
            <UserRow
              key={f.id}
              index={i}
              userId={f.id}
              hasAvatar={f.hasAvatar}
              name={f.displayName}
              sub={isMember ? "メンバー" : `@${f.username}`}
              check={{ checked: order.includes(f.id), disabled: isMember }}
              onClick={() => toggle(f.id)}
            />
          );
        })}
      </ul>

      {error && <p className="notice center error shake">{error}</p>}
    </div>
  );
}
