import { BUILTIN_STAMPS } from "./stamps";
import { useExitClose } from "./useExitClose";

// スタンプの一覧（src/stamps/ の画像）。選ぶと閉じてから送る
export function StampSheet({ onPick, onClose }: { onPick: (ref: string) => void; onClose: () => void }) {
  const { closing, close } = useExitClose(onClose);
  return (
    <div className={`sheet-backdrop${closing ? " is-closing" : ""}`} onClick={() => close()}>
      <div
        className={`sheet stamp-sheet${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-label="スタンプ"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title-row">
          <span />
          <strong>スタンプ</strong>
          <button type="button" className="icon-btn modal-x" onClick={() => close()} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="stamp-body">
          {BUILTIN_STAMPS.length === 0 ? (
            <p className="stamp-empty">src/stamps/ に画像を入れると、ここに出ます。</p>
          ) : (
            <div className="stamp-grid">
              {BUILTIN_STAMPS.map((s) => (
                <button
                  key={s.ref}
                  type="button"
                  className="stamp-btn"
                  onClick={() => close(() => onPick(s.ref))}
                  aria-label={s.name}
                >
                  <img src={s.url} alt={s.name} loading="lazy" decoding="async" width={64} height={64} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
