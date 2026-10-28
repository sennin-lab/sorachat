import { useState, type FormEvent } from "react";
import { ApiError, api, post } from "./api";

type Tab = "direct" | "group";

export function NewChatSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("direct");
  const [username, setUsername] = useState("");
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const usernames = members
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        tab === "direct"
          ? await api<{ id: string }>("/api/dm/open", post({ username: username.trim().toLowerCase() }))
          : await api<{ id: string }>("/api/dm/group", post({ title: title.trim(), usernames }));
      onOpen(result.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "通信に失敗しました。");
      setBusy(false);
    }
  };

  const ready = tab === "direct" ? username.trim().length > 0 : title.trim().length > 0 && usernames.length > 0;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="seg">
          <button className={tab === "direct" ? "on" : ""} onClick={() => setTab("direct")}>
            1対1
          </button>
          <button className={tab === "group" ? "on" : ""} onClick={() => setTab("group")}>
            グループ
          </button>
        </div>
        <form onSubmit={submit} className="sheet-form">
          {tab === "direct" ? (
            <label className="field">
              <span>相手のユーザー名</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例: sora_01"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                maxLength={20}
              />
            </label>
          ) : (
            <>
              <label className="field">
                <span>グループ名</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} autoFocus />
              </label>
              <label className="field">
                <span>メンバーのユーザー名（カンマ区切り、{usernames.length}人）</span>
                <textarea
                  value={members}
                  onChange={(e) => setMembers(e.target.value)}
                  rows={3}
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="sora_01, kaito_22"
                />
              </label>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="sheet-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              キャンセル
            </button>
            <button className="btn primary" disabled={busy || !ready}>
              開始
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
