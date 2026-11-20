// はい／いいえで答える確認（背景を押しても閉じない。キャンセルで閉じる）
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="sheet-backdrop confirm-backdrop">
      <div className="sheet confirm-sheet" role="alertdialog" aria-modal="true" aria-label={title}>
        <strong className="confirm-title">{title}</strong>
        <p className="confirm-text">{message}</p>
        <div className="confirm-actions">
          <button className="btn-secondary" disabled={busy} onClick={onCancel}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            style={danger ? { background: "var(--danger)" } : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
