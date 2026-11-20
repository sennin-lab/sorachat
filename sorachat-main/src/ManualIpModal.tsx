import { useState } from "react";

// IPアドレスの形（IPv4 か、IPv6 の文字だけ）。細かい判定はサーバーがする
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function isLikelyIp(raw: string): boolean {
  const value = raw.trim();
  if (IPV4.test(value)) return true;
  return value.includes(":") && value.length <= 45 && /^[0-9a-f:.]+$/i.test(value);
}

// IP が取得できなかったときに出す、手入力のモーダル（登録画面と管理者パネルで使う）
export function ManualIpModal({
  title,
  message,
  busy,
  error,
  confirmLabel = "送信",
  onSubmit,
  onCancel
}: {
  title: string;
  message: string;
  busy?: boolean;
  error?: string;
  confirmLabel?: string;
  onSubmit: (ip: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const valid = isLikelyIp(value);
  return (
    <div className="sheet-backdrop confirm-backdrop">
      <div className="sheet confirm-sheet manual-ip-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <strong className="confirm-title">{title}</strong>
        <p className="confirm-text">{message}</p>
        <input
          className="manual-ip-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例：203.0.113.10"
          aria-label="IPアドレス"
          inputMode="decimal"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        {value.length > 0 && !valid && <p className="manual-ip-hint">IPアドレスの形で入力してください（例：203.0.113.10）</p>}
        {error && <p className="manual-ip-error">{error}</p>}
        <div className="confirm-actions">
          <button className="btn-secondary" disabled={busy} onClick={onCancel}>
            キャンセル
          </button>
          <button className="btn-primary" disabled={busy || !valid} onClick={() => onSubmit(value.trim())}>
            {busy ? "送信中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
