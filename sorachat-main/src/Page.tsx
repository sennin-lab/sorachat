import type { ReactNode } from "react";
import { Icon } from "./Icon";

// 専用ページの枠（仙人ストア・senninstudio）。画面いっぱいに開き、左上の矢印で戻る。
// 中身は枠の中だけでスクロールする。wide のときは、デスクトップで横に広く使う（ストア・開発者画面）。
export function Page({ title, onBack, children, wide = false }: { title: string; onBack: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`page${wide ? " page-wide" : ""}`} role="region" aria-label={title}>
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
