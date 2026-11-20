import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./Icon";
import { BUILTIN_STAMPS, canonicalStampRef } from "./stamps";
import { useExitClose } from "./useExitClose";
import type { StoreView } from "./types";

// スタンプの一覧（src/stamps/ の画像）。選ぶと閉じてから送る
// 仙人ストアのパックに入っているスタンプは、買っていないと送れない（鍵の印を付ける）
export function StampSheet({ onPick, onClose }: { onPick: (ref: string) => void; onClose: () => void }) {
  const { closing, close } = useExitClose(onClose);
  // 未購入のパックに入っているスタンプ（正規化した名前）
  const [locked, setLocked] = useState<Set<string>>(() => new Set());
  // 買った作品のスタンプ（studio:画像ID と見本の画像）
  const [studioStamps, setStudioStamps] = useState<{ ref: string; url: string; name: string }[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    api<StoreView>("/api/store")
      .then((view) => {
        const next = new Set<string>();
        const owned: { ref: string; url: string; name: string }[] = [];
        for (const item of view.items) {
          if (item.kind !== "stamp_pack") continue;
          if (item.source === "studio") {
            if (item.owned) for (const ref of item.stamps ?? []) owned.push({ ref, url: ref.replace("studio:", "/api/studio/images/"), name: item.name });
            continue;
          }
          if (!item.owned) for (const ref of item.stamps ?? []) next.add(ref);
        }
        setLocked(next);
        setStudioStamps(owned);
      })
      .catch(() => undefined);
  }, []);

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
              {BUILTIN_STAMPS.map((s) => {
                const isLocked = locked.has(canonicalStampRef(s.ref));
                return (
                  <button
                    key={s.ref}
                    type="button"
                    className={`stamp-btn${isLocked ? " is-locked" : ""}`}
                    onClick={() => {
                      if (isLocked) {
                        setNote("このスタンプは、仙人ストアのスタンプパックに入っています。購入すると送れます。");
                        return;
                      }
                      close(() => onPick(s.ref));
                    }}
                    aria-label={isLocked ? `${s.name}（ストアで購入）` : s.name}
                  >
                    <img src={s.url} alt={s.name} loading="lazy" decoding="async" width={64} height={64} />
                    {isLocked && (
                      <span className="stamp-lock" aria-hidden="true">
                        <Icon name="lock" size={14} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {studioStamps.length > 0 && (
            <>
              <p className="stamp-label">作品のスタンプ</p>
              <div className="stamp-grid">
                {studioStamps.map((s) => (
                  <button key={s.ref} type="button" className="stamp-btn" onClick={() => close(() => onPick(s.ref))} aria-label={s.name}>
                    <img src={s.url} alt={s.name} loading="lazy" decoding="async" width={64} height={64} />
                  </button>
                ))}
              </div>
            </>
          )}
          {note && <p className="stamp-note" role="status">{note}</p>}
        </div>
      </div>
    </div>
  );
}
