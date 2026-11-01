import { useState } from "react";
import { ApiError, api, post } from "./api";
import { RobotFace } from "./robot";

// senninai が「送ってよいか」を聞いたときの確認（はい／いいえのボタン。背景を押しても閉じない）
export function SenninaiConfirm({ summary, onDone }: { summary: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const answer = async (yes: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/senninai/pending", post({ answer: yes ? "yes" : "no" }));
      onDone();
    } catch (err) {
      // 確認待ちが既になければ閉じる（別の端末で答えたなど）
      if (err instanceof ApiError && err.status === 404) onDone();
      else setError(err instanceof ApiError ? err.message : "通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop confirm-backdrop">
      <div className="sheet confirm-sheet" role="alertdialog" aria-modal="true" aria-label="senninaiからの確認">
        <div className="confirm-head">
          <span className="confirm-robot">
            <RobotFace />
          </span>
          <strong>senninai</strong>
        </div>
        <p className="confirm-text">{summary}</p>
        {error && <p className="notice error small">{error}</p>}
        <div className="confirm-actions">
          <button className="btn-secondary" disabled={busy} onClick={() => void answer(false)}>
            いいえ
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => void answer(true)}>
            はい
          </button>
        </div>
      </div>
    </div>
  );
}
