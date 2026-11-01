import { useEffect, useState } from "react";
import { ApiError, api, delete_, post } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import type { Conversation } from "./types";

// 1対1（個人チャット）の設定：通知のオン・オフ、ブロック、トークの削除
// グループの設定はグループ情報（GroupSheet）にある
export function RoomSettingsSheet({
  conversation,
  onClose,
  onChanged,
  onRemoved
}: {
  conversation: Conversation;
  onClose: () => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [muted, setMuted] = useState(conversation.muted);
  // ブロック中かどうか（null は確認中）
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [askDelete, setAskDelete] = useState(false);
  const [askBlock, setAskBlock] = useState(false);
  const otherId = conversation.otherId;

  useEffect(() => {
    if (!otherId) return;
    api<{ id: string }[]>("/api/blocks")
      .then((list) => setBlocked(list.some((b) => b.id === otherId)))
      .catch(() => setBlocked(false));
  }, [otherId]);

  const toggleNotify = async (on: boolean) => {
    setBusy(true);
    setError("");
    setMuted(!on);
    try {
      await api(`/api/dm/${conversation.id}/mute`, post({ muted: !on }));
      onChanged();
    } catch (err) {
      setMuted(on);
      setError(err instanceof ApiError ? err.message : "通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  // ブロックすると友だちと申請は消え、トークは送れなくなる（サーバー側で同じことをする）
  const block = async () => {
    if (!otherId) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/blocks/${otherId}`, post());
      setBlocked(true);
      setAskBlock(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ブロックできませんでした。");
      setAskBlock(false);
    } finally {
      setBusy(false);
    }
  };

  const unblock = async () => {
    if (!otherId) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/blocks/${otherId}`, delete_());
      setBlocked(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "解除できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/dm/${conversation.id}/delete`, post());
      onRemoved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "削除できませんでした。");
      setAskDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" role="dialog" aria-label="トークの設定">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>トークの設定</strong>
        <span />
      </header>

      <div className="section-label flush">
        <span>通知</span>
      </div>
      <div className="page-card">
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="bell" size={18} />
            </span>
            このトークの通知
          </span>
          <input type="checkbox" className="switch" checked={!muted} disabled={busy} onChange={(e) => void toggleNotify(e.target.checked)} />
        </label>
      </div>
      <p className="notice center small">オフにしても、未読の数は残ります。通知だけ届かなくなります。</p>

      {otherId && (
        <>
          <div className="section-label flush">
            <span>ブロック</span>
          </div>
          {blocked === true && (
            <div className="page-card">
              <p className="page-row static muted">この人をブロックしています。トークは送れず、発言も表示されません。</p>
              <button className="page-row accent" disabled={busy} onClick={() => void unblock()}>
                ブロックを解除
              </button>
            </div>
          )}
          {blocked === false && (
            <div className="page-card">
              <button className="page-row danger" disabled={busy} onClick={() => setAskBlock(true)}>
                ブロックする
              </button>
            </div>
          )}
          <p className="notice center small">ブロックすると友だちから外れ、どちらからもトークを送れなくなります。</p>
        </>
      )}

      <div className="section-label flush">
        <span>削除</span>
      </div>
      <div className="page-card">
        <button className="page-row danger" disabled={busy} onClick={() => setAskDelete(true)}>
          <Icon name="trash" size={18} /> トークを削除
        </button>
      </div>
      <p className="notice center small">
        自分の画面から消えます。相手の画面には残ります。相手も削除すると、メッセージ・画像・ファイルは完全に消えます。
      </p>

      {error && <p className="notice center error shake">{error}</p>}

      {askBlock && (
        <ConfirmDialog
          title="ブロックしますか？"
          message={`${conversation.name} さんをブロックします。友だちから外れ、トークは送れなくなります。`}
          confirmLabel="ブロックする"
          danger
          busy={busy}
          onConfirm={() => void block()}
          onCancel={() => setAskBlock(false)}
        />
      )}
      {askDelete && (
        <ConfirmDialog
          title="このトークを削除しますか？"
          message={`${conversation.name} さんとのトークは自分の画面から消えます。元に戻せません。`}
          confirmLabel="削除する"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setAskDelete(false)}
        />
      )}
    </div>
  );
}
