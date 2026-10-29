import { useState } from "react";
import { ApiError, api, patch } from "./api";
import { Icon } from "./Icon";
import { disablePush, enablePush } from "./push";
import type { Me } from "./types";

// 設定（LINE の設定画面のように、項目をグループ分けして表示する）
export function SettingsSheet({
  me,
  theme,
  onThemeChange,
  onChange,
  onClose,
  onLogout
}: {
  me: Me;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onChange: (me: Me) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [notify, setNotify] = useState(me.notifyDm);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const toggleNotify = async (on: boolean) => {
    setBusy(true);
    setStatus("");
    setNotify(on);
    try {
      onChange(await api<Me>("/api/me", patch({ notifyDm: on })));
      if (on) await enablePush();
      else await disablePush();
    } catch (err) {
      setNotify(!on);
      setStatus(err instanceof ApiError ? err.message : "通知の設定を変更できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  };

  return (
    <div className="page" role="dialog" aria-label="設定">
      <header className="page-bar">
        <button onClick={onClose} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <strong>設定</strong>
        <span />
      </header>

      <div className="section-label flush">
        <span>表示</span>
      </div>
      <div className="page-card">
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="moon" size={18} />
            </span>
            ダークモード
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={theme === "dark"}
            onChange={(e) => onThemeChange(e.target.checked ? "dark" : "light")}
          />
        </label>
      </div>

      <div className="section-label flush">
        <span>通知</span>
      </div>
      <div className="page-card">
        <label className="page-row">
          <span className="row-label">
            <span className="option-icon">
              <Icon name="bell" size={18} />
            </span>
            新着メッセージの通知
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={notify}
            disabled={busy}
            onChange={(e) => void toggleNotify(e.target.checked)}
          />
        </label>
      </div>

      <div className="section-label flush">
        <span>アカウント</span>
      </div>
      <div className="page-card">
        <button className="page-row danger" onClick={() => void logout()}>
          <span>ログアウト</span>
        </button>
      </div>

      {status && <p className="notice center error shake">{status}</p>}
    </div>
  );
}
