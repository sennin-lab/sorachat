import { useEffect, useRef, useState } from "react";
import { ApiError, api, delete_, post } from "./api";
import { BUILTIN_STAMPS } from "./stamps";

type UserStamp = { ref: string; id: string; url: string };

// 「＋」の代わりに出るスタンプの一覧。用意されたスタンプと、自分でアップロードしたスタンプを選ぶ
export function StampSheet({ onPick, onClose }: { onPick: (ref: string) => void; onClose: () => void }) {
  const [mine, setMine] = useState<UserStamp[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ stamps: UserStamp[] }>("/api/stamps")
      .then((data) => setMine(data.stamps))
      .catch(() => setError("自分のスタンプを読み込めませんでした。"));
  }, []);

  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const created = await api<UserStamp>("/api/stamps", { method: "POST", body: form });
      setMine((list) => [created, ...list]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "アップロードできませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (stamp: UserStamp) => {
    if (!window.confirm("このスタンプを削除しますか？ 送信済みのトークでは表示されなくなります。")) return;
    try {
      await api(`/api/stamps/${stamp.id}`, delete_());
      setMine((list) => list.filter((s) => s.id !== stamp.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "削除できませんでした。");
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet stamp-sheet" role="dialog" aria-label="スタンプ" onClick={(e) => e.stopPropagation()}>
        <div className="stamp-head">
          <strong>スタンプ</strong>
          <button type="button" className="chip" onClick={() => setEditing((v) => !v)}>
            {editing ? "完了" : "編集"}
          </button>
        </div>
        {error && <p className="stamp-error">{error}</p>}

        <p className="stamp-label">自分のスタンプ</p>
        <div className="stamp-grid">
          <button type="button" className="stamp-add" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="スタンプを追加">
            {busy ? "…" : "＋"}
          </button>
          {mine.map((s) => (
            <div key={s.ref} className="stamp-cell">
              <button type="button" className="stamp-btn" onClick={() => !editing && onPick(s.ref)}>
                <img src={s.url} alt="" />
              </button>
              {editing && (
                <button type="button" className="stamp-del" onClick={() => void remove(s)} aria-label="削除">
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        <p className="stamp-label">用意されたスタンプ</p>
        {BUILTIN_STAMPS.length === 0 ? (
          <p className="stamp-empty">src/stamps/ に画像を入れると、ここに出ます。</p>
        ) : (
          <div className="stamp-grid">
            {BUILTIN_STAMPS.map((s) => (
              <button key={s.ref} type="button" className="stamp-btn" onClick={() => onPick(s.ref)} aria-label={s.name}>
                <img src={s.url} alt={s.name} />
              </button>
            ))}
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/webp,image/gif,image/jpeg"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
    </div>
  );
}
