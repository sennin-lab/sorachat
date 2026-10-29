import { ApiError, api, patch } from "./api";
import { Icon } from "./Icon";
import { disablePush, enablePush } from "./push";
import { useState } from "react";
import type { Me } from "./types";

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
    // 許可ダイアログはユーザー操作の直後に出す必要があるため、APIを待つ前に通知の登録を始める
    const pushResult = on ? enablePush() : null;
    try {
      if (on) {
        const result = await pushResult!;
        if (!result.ok) {
          // 許可されなかった場合はトグルを戻し、理由を表示する
          setNotify(false);
          setStatus(result.message);
          onChange(await api<Me>("/api/me", patch({ notifyDm: false })));
          return;
        }
        setStatus(result.message);
      } else {
        await disablePush();
      }
      onChange(await api<Me>("/api/me", patch({ notifyDm: on })));
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

      <div className="page-card">
        <label className="page-row">
          <span>ダークモード</span>
          <input
            type="checkbox"
            className="switch"
            checked={theme === "dark"}
            onChange={(e) => onThemeChange(e.target.checked ? "dark" : "light")}
          />
        </label>
        <label className="page-row">
          <span>新着メッセージの通知</span>
          <input
            type="checkbox"
            className="switch"
            checked={notify}
            disabled={busy}
            onChange={(e) => void toggleNotify(e.target.checked)}
          />
        </label>
      </div>

      <div className="page-card">
        <button className="page-row danger" onClick={() => void logout()}>
          <span>ログアウト</span>
        </button>
      </div>

      {status && <p className="notice center error">{status}</p>}
    </div>
  );
}
