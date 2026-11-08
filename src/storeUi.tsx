import type { RatingSummary, StoreItemView, WorkKind } from "./types";

// Chrome ウェブストアの星と同じ形（塗りつぶしは CSS の色で変える）
const STAR_PATH = "M12 2.8l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.3 1.2-6.5-4.8-4.6 6.6-.9z";

function StarRow({ size }: { size: number }) {
  return (
    <span className="cws-star-row" style={{ gap: Math.max(1, Math.round(size / 8)) }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d={STAR_PATH} />
        </svg>
      ))}
    </span>
  );
}

// 平均の星の表示（0.1 刻みの割合で塗る）。評価がないときは空の星
export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span className="cws-stars" role="img" aria-label={`星 ${value.toFixed(1)} / 5`}>
      <span className="cws-stars-back">
        <StarRow size={size} />
      </span>
      <span className="cws-stars-front" style={{ width: `${pct}%` }}>
        <StarRow size={size} />
      </span>
    </span>
  );
}

// 星を選ぶ入力（1〜5）
export function StarPicker({ value, onChange, size = 28, disabled = false }: { value: number; onChange: (n: number) => void; size?: number; disabled?: boolean }) {
  return (
    <div className="cws-star-picker" role="radiogroup" aria-label="星の数">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`星${n}`}
          className={`cws-star-pick${n <= value ? " on" : ""}`}
          disabled={disabled}
          onClick={() => onChange(n)}
        >
          <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d={STAR_PATH} />
          </svg>
        </button>
      ))}
    </div>
  );
}

export const KIND_LABEL: Record<WorkKind | "extension", string> = {
  theme: "外観",
  stamp_pack: "スタンプ",
  quiz: "クイズ",
  ai_style: "応答スタイル",
  extension: "拡張機能"
};

// 商品の種類の表示名（一覧・詳細で共通）
export function kindLabelOf(item: Pick<StoreItemView, "kind" | "studioKind">): string {
  if (item.studioKind) return KIND_LABEL[item.studioKind];
  return KIND_LABEL[item.kind] ?? "拡張機能";
}

export const yen = (n: number) => n.toLocaleString("ja-JP");

export function dateText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
}

// 評価の表示文（件数がないとき）
export function ratingLabel(rating: RatingSummary | null | undefined): string {
  if (!rating || rating.count === 0) return "レビューなし";
  return `${rating.avg.toFixed(1)}（${rating.count}件）`;
}

export const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// 商品のアイコン（サムネイル。なければ種類ごとの見本）
export function WorkIcon({ item, size = 48 }: { item: Pick<StoreItemView, "thumbUrl" | "kind" | "studioKind">; size?: number }) {
  if (item.thumbUrl) {
    return <img className="cws-icon-img" src={item.thumbUrl} alt="" width={size} height={size} loading="lazy" style={{ width: size, height: size }} />;
  }
  const isTheme = item.kind === "theme";
  const glyph = isTheme ? "" : item.kind === "stamp_pack" ? "🙂" : item.studioKind === "quiz" ? "?" : item.studioKind === "ai_style" ? "✎" : "◆";
  return (
    <span className={`cws-icon-fallback${isTheme ? " is-theme" : ""}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {glyph}
    </span>
  );
}
