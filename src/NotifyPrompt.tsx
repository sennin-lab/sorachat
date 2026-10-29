import { useState } from "react";
import { api, patch } from "./api";
import { Icon } from "./Icon";
import { enablePush } from "./push";
import type { Me } from "./types";

// 通知がオフのときに出す確認。ボタンを押した直後に許可を求めるので、iOS でも確認が出る
export function NotifyPrompt({ onEnabled, onLater }: { onEnabled: (me: Me) => void; onLater: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const turnOn = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await enablePush();
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      onEnabled(await api<Me>("/api/me", patch({ notifyDm: true })));
    } catch {
      setMessage("通知を有効にできませんでした。通信状態を確認してください。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop notify-backdrop" role="dialog" aria-modal="true" aria-label="通知の確認">
      <div className="notify-modal">
        <span className="notify-icon" aria-hidden="true">
          <Icon name="bell" size={28} />
        </span>
        <h2>通知をオンにしますか？</h2>
        <p>新着メッセージが届いたときに、すぐお知らせします。あとからいつでも「設定」で変更できます。</p>
        {message && <p className="notice error center">{message}</p>}
        <button className="btn-primary wide" onClick={() => void turnOn()} disabled={busy}>
          通知をオンにする
        </button>
        <button className="btn-text" onClick={onLater} disabled={busy}>
          あとで
        </button>
      </div>
    </div>
  );
}
