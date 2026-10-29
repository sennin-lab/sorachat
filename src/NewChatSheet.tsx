import { useEffect, useState } from "react";
import { ApiError, api, post } from "./api";
import { FriendSelectPage } from "./FriendSelectPage";
import { Icon } from "./Icon";
import { UserRow } from "./UserRow";
import type { Friend } from "./types";

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。");

// 「新規トーク」：友だちを選んで1対1で話す、またはグループを作る
export function NewChatSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<"start" | "group">("start");
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Friend[]>("/api/friends")
      .then(setFriends)
      .catch(() => setFriends([]));
  }, []);

  const openDirect = async (username: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/api/dm/open", post({ username }));
      onOpen(result.id);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const createGroup = async (picked: Friend[], name: string) => {
    // 名前が空なら、選んだ人の名前を並べて自動でつける
    const autoTitle = picked.map((f) => f.displayName).join("、").slice(0, 40);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>(
        "/api/dm/group",
        post({ title: name || autoTitle, usernames: picked.map((f) => f.username) })
      );
      onOpen(result.id);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  if (mode === "group") {
    return (
      <FriendSelectPage
        title="グループを作成"
        friends={friends ?? []}
        confirmLabel="作成"
        showName
        busy={busy}
        error={error}
        emptyText="グループに追加できる友だちがいません。先に友だちを追加してください。"
        onConfirm={(picked, name) => void createGroup(picked, name)}
        onClose={() => setMode("start")}
      />
    );
  }

  const q = query.trim().toLowerCase();
  const shown = (friends ?? []).filter((f) => !q || f.displayName.toLowerCase().includes(q) || f.username.includes(q));

  return (
    <div className="page" role="dialog" aria-label="新規トーク">
      <header className="page-bar">
        <button onClick={onClose} aria-label="閉じる">
          <Icon name="close" size={24} />
        </button>
        <strong>新規トーク</strong>
        <span />
      </header>

      <div className="option-list">
        <button onClick={() => setMode("group")}>
          <span className="option-icon">
            <Icon name="users" size={20} />
          </span>
          <span>グループを作成</span>
          <Icon name="chevron" size={18} className="chev" />
        </button>
      </div>

      <div className="section-label">
        <span>友だち</span>
        {friends && <span className="section-count">{friends.length}</span>}
      </div>

      <div className="search-bar">
        <label className="search-field">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="検索" aria-label="友だちを検索" />
        </label>
      </div>

      {friends && !friends.length && <p className="muted center pad">友だちがまだいません。友だち追加から追加できます。</p>}
      <ul className="user-list-ul">
        {shown.map((f, i) => (
          <UserRow
            key={f.id}
            index={i}
            userId={f.id}
            hasAvatar={f.hasAvatar}
            name={f.displayName}
            sub={`@${f.username}`}
            onClick={busy ? undefined : () => void openDirect(f.username)}
          />
        ))}
      </ul>

      {error && <p className="notice center error shake">{error}</p>}
    </div>
  );
}
