import type { ReactNode } from "react";
import { Icon } from "./Icon";

// 専用ページの枠（仙人ストア・senninstudio）。画面いっぱいに開き、左上の矢印で戻る。
// 中身は枠の中だけでスクロールする。
export function Page({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="page" role="region" aria-label={title}>
      <header className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="戻る">
          <Icon name="back" size={22} />
        </button>
        <h1>{title}</h1>
        <span />
      </header>
      <div className="page-scroll">
        <div className="page-body">{children}</div>
      </div>
    </div>
  );
}
