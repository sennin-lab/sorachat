import { useState } from "react";
import { ApiError, api, post } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import type { Conversation } from "./types";

// トークの設定：このトークだけの通知のオン・オフ、トークの削除（1対1は削除、グループは退出）
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [askDelete, setAskDelete] = useState(false);
  const isGroup = conversation.isGroup;

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

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/dm/${conversation.id}/${isGroup ? "leave" : "delete"}`, post());
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

      <div className="section-label flush">
        <span>削除</span>
      </div>
      <div className="page-card">
        <button className="page-row danger" disabled={busy} onClick={() => setAskDelete(true)}>
          <Icon name="trash" size={18} /> {isGroup ? "退出してトークを削除" : "トークを削除"}
        </button>
      </div>
      <p className="notice center small">
        {isGroup
          ? "退出すると、このトークは自分の画面から消えます。メンバー全員が抜けると、メッセージ・画像・ファイルは完全に消えます。"
          : "自分の画面から消えます。相手の画面には残ります。相手も削除すると、メッセージ・画像・ファイルは完全に消えます。"}
      </p>

      {error && <p className="notice center error shake">{error}</p>}

      {askDelete && (
        <ConfirmDialog
          title={isGroup ? "このグループから退出しますか？" : "このトークを削除しますか？"}
          message={isGroup ? "このトークは自分の画面から消えます。" : `${conversation.name} さんとのトークは自分の画面から消えます。元に戻せません。`}
          confirmLabel={isGroup ? "退出する" : "削除する"}
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setAskDelete(false)}
        />
      )}
    </div>
  );
}
