import { useEffect, useState, type ReactNode } from "react";
import { api, delete_, post } from "./api";
import { ExtensionRunner } from "./ExtensionRunner";
import { Icon } from "./Icon";
import { BUILTIN_STAMPS, canonicalStampRef } from "./stamps";
import { StarPicker, Stars, WorkIcon, dateText, errorText, kindLabelOf, yen } from "./storeUi";
import type { RatingSummary, ReviewView, StoreDetailView, StoreItemView } from "./types";

type Tab = "overview" | "reviews" | "author";

// 運営の外観（固定の商品）の見本の色
const FIXED_THEME_PREVIEW: Record<string, { mine: string; bg: string; accent: string }> = {
  "theme-sakura": { mine: "#ffd6e5", bg: "#fff7fa", accent: "#e0789f" },
  "theme-matcha": { mine: "#d4efc9", bg: "#f5fbf2", accent: "#5ea46b" },
  "theme-sora": { mine: "#cfe9ff", bg: "#f2f8ff", accent: "#4f9fe0" },
  "theme-yuyake": { mine: "#ffd7b8", bg: "#fff8f2", accent: "#e8834a" }
};

const TONE_TEXT: Record<string, string> = { やさしい: "やさしい", ていねい: "ていねい", ふつう: "ふつう", カジュアル: "カジュアル" };

export function StoreDetail({
  item,
  me,
  linked,
  points,
  busyId,
  buyButton,
  onUseTheme,
  onUseAiStyle,
  onReport,
  onOpenAuthor,
  onEdit
}: {
  item: StoreItemView;
  me: { id: string };
  linked: boolean;
  points: number | null;
  busyId: string | null;
  // 購入ボタン（一覧と同じ判定で、親が作る）
  buyButton: ReactNode;
  onUseTheme: (itemId: string | null) => void;
  onUseAiStyle: (itemId: string | null) => void;
  onReport: (item: StoreItemView) => void;
  onOpenAuthor: (creatorId: string) => void;
  onEdit: (workId: string) => void;
}) {
  const studio = item.source === "studio";
  // 作品のID（ストアの商品IDから「work:」を外した、サーバーで使う形）
  const workId = item.id.replace(/^work:/, "");
  const [detail, setDetail] = useState<StoreDetailView | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [version, setVersion] = useState(0);
  const [running, setRunning] = useState(false);

  // 作品の詳細（レビュー・作者の評価）は、開いたときと、購入やレビューの後に取り直す
  useEffect(() => {
    if (!studio) return;
    let alive = true;
    api<StoreDetailView>(`/api/store/items/${workId}`)
      .then((next) => {
        if (!alive) return;
        setDetail(next);
        setError("");
      })
      .catch((e) => {
        if (alive) setError(errorText(e, "詳細を読み込めませんでした。"));
      });
    return () => {
      alive = false;
    };
  }, [studio, workId, item.owned, version]);

  const reload = () => setVersion((v) => v + 1);
  const rating: RatingSummary = detail?.rating ?? item.rating ?? { avg: 0, count: 0, distribution: [0, 0, 0, 0, 0] };
  const isMine = studio && item.creatorId === me.id;

  // 持っている外観・応答スタイルは、ここから使う・やめる
  const primary = (): ReactNode => {
    if (item.owned && item.kind === "theme") {
      return item.selected ? (
        <button type="button" className="cws-outline" disabled={busyId !== null} onClick={() => onUseTheme(null)}>
          使用中（標準に戻す）
        </button>
      ) : (
        <button type="button" className="cws-primary" disabled={busyId !== null} onClick={() => onUseTheme(item.id)}>
          この外観を使う
        </button>
      );
    }
    if (item.owned && item.studioKind === "ai_style") {
      return item.selected ? (
        <button type="button" className="cws-outline" disabled={busyId !== null} onClick={() => onUseAiStyle(null)}>
          使用中（標準に戻す）
        </button>
      ) : (
        <button type="button" className="cws-primary" disabled={busyId !== null} onClick={() => onUseAiStyle(item.id)}>
          この応答スタイルを使う
        </button>
      );
    }
    // 拡張機能は、買った人（と作者）がここから開く
    if (item.studioKind === "extension" && (item.owned || isMine)) {
      return (
        <button type="button" className="cws-primary" onClick={() => setRunning(true)}>
          <Icon name="play" size={16} /> 開く
        </button>
      );
    }
    return buyButton;
  };

  // 見本（外観の色・応答スタイル・スタンプ・問題数）
  const showcase = (): ReactNode => {
    if (item.kind === "theme") {
      const palette = detail?.palette ?? FIXED_THEME_PREVIEW[item.id] ?? null;
      if (!palette?.mine) return null;
      return (
        <div className="cws-theme-preview" style={{ background: palette.bg ?? "#fff" }} aria-label="外観の見本">
          <span className="cws-theme-bubble" style={{ background: palette.mine }}>
            こんにちは
          </span>
          <span className="cws-theme-accent" style={{ background: palette.accent ?? "#999" }} />
        </div>
      );
    }
    if (item.studioKind === "ai_style") {
      const style = detail?.aiStyle;
      if (!style) return null;
      return (
        <ul className="cws-chips" aria-label="応答スタイルの設定">
          <li>口調: {TONE_TEXT[style.tone ?? ""] ?? style.tone}</li>
          <li>長さ: {style.length}</li>
          <li>{style.emoji ? "絵文字を使う" : "絵文字は使わない"}</li>
        </ul>
      );
    }
    if (item.studioKind === "extension") {
      const bytes = detail?.extensionBytes ?? null;
      return (
        <p className="cws-quiz-count">
          HTML・CSS・JavaScript で作られたミニアプリです。隔離された枠の中で動き、アカウント情報や通信には触れません。
          {bytes !== null ? `（コードの大きさ 約 ${Math.max(1, Math.round(bytes / 1024))} KB。中身は買うと動かせます）` : ""}
        </p>
      );
    }
    if (item.studioKind === "quiz") {
      const count = detail?.quizCount ?? null;
      return count === null ? null : <p className="cws-quiz-count">4択の問題 {count} 問（対戦では5問ずつ出題されます）</p>;
    }
    const stampUrls = studio
      ? (detail?.stamps ?? [])
      : BUILTIN_STAMPS.filter((s) => (item.stamps ?? []).includes(canonicalStampRef(s.ref))).map((s) => s.url);
    if (item.kind === "stamp_pack" && stampUrls.length) {
      return (
        <ul className="cws-shots" aria-label="スタンプの見本">
          {stampUrls.slice(0, 12).map((src, i) => (
            <li key={`${src}-${i}`}>
              <img src={src} alt="" loading="lazy" />
            </li>
          ))}
        </ul>
      );
    }
    return null;
  };

  const reviews = detail?.reviews ?? [];
  const total = rating.count;

  return (
    <div className="cws-detail">
      <header className="cws-hero">
        <div className="cws-hero-icon">
          <WorkIcon item={item} size={96} />
        </div>
        <div className="cws-hero-info">
          <h1 className="cws-hero-title">{item.name}</h1>
          {studio ? (
            <button type="button" className="cws-author-btn" onClick={() => item.creatorId && onOpenAuthor(item.creatorId)}>
              {item.creatorName || "作者"}
            </button>
          ) : (
            <span className="cws-author-plain">仙人ストア（運営）</span>
          )}
          <div className="cws-hero-meta">
            {studio && (
              <span className="cws-hero-rating">
                <Stars value={rating.avg} size={14} />
                <b>{total > 0 ? rating.avg.toFixed(1) : "—"}</b>
                <span>（{total}件のレビュー）</span>
              </span>
            )}
            <span>{kindLabelOf(item)}</span>
            {studio && <span>{detail?.sales ?? item.sales ?? 0} 件購入</span>}
          </div>
          <div className="cws-hero-actions">
            {primary()}
            {isMine && (
              <button type="button" className="cws-outline" onClick={() => onEdit(workId)}>
                <Icon name="edit" size={16} /> 編集する
              </button>
            )}
          </div>
          {linked && points !== null && !item.owned && <small className="cws-hint">保有 {yen(points)} pt</small>}
          {error && <p className="cws-error-inline">{error}</p>}
        </div>
      </header>

      <nav className="cws-tabs" role="tablist" aria-label="掲載ページの項目">
        <button type="button" role="tab" aria-selected={tab === "overview"} className={`cws-tab${tab === "overview" ? " on" : ""}`} onClick={() => setTab("overview")}>
          概要
        </button>
        {studio && (
          <button type="button" role="tab" aria-selected={tab === "reviews"} className={`cws-tab${tab === "reviews" ? " on" : ""}`} onClick={() => setTab("reviews")}>
            レビュー{total > 0 ? ` (${total})` : ""}
          </button>
        )}
        {studio && (
          <button type="button" role="tab" aria-selected={tab === "author"} className={`cws-tab${tab === "author" ? " on" : ""}`} onClick={() => setTab("author")}>
            作者
          </button>
        )}
      </nav>

      {tab === "overview" && (
        <section className="cws-panel">
          {showcase()}
          <h2 className="cws-subheading">説明</h2>
          <p className="cws-desc">{item.description || "説明はありません。"}</p>
          <dl className="cws-facts">
            <div>
              <dt>種類</dt>
              <dd>{kindLabelOf(item)}</dd>
            </div>
            <div>
              <dt>価格</dt>
              <dd>{item.price > 0 ? `${yen(item.price)} pt` : "無料"}</dd>
            </div>
            {studio && detail && (
              <>
                <div>
                  <dt>公開日</dt>
                  <dd>{dateText(detail.createdAt)}</dd>
                </div>
                <div>
                  <dt>最終更新</dt>
                  <dd>{dateText(detail.editedAt ?? detail.createdAt)}</dd>
                </div>
              </>
            )}
          </dl>
          {studio && !isMine && (
            <p className="cws-hint">
              作者が内容を直すと、買った人の画面にも新しい内容が届きます。
              {" "}
              <button type="button" className="cws-link-btn" onClick={() => onReport(item)}>
                この作品を通報する
              </button>
            </p>
          )}
        </section>
      )}

      {tab === "reviews" && studio && (
        <section className="cws-panel">
          <ReviewSummary rating={rating} />
          {detail && (
            <ReviewForm
              key={detail.myReview ? `${detail.myReview.updatedAt}-${detail.myReview.rating}` : "new"}
              workId={workId}
              canReview={detail.canReview}
              isMine={detail.isMine}
              owned={detail.owned}
              myReview={detail.myReview}
              onSaved={reload}
            />
          )}
          {!detail && !error && <p className="cws-empty">読み込み中…</p>}
          {reviews.length > 0 && (
            <ul className="cws-reviews">
              {reviews.map((review) => (
                <ReviewItem key={`${review.reviewerId}`} review={review} />
              ))}
            </ul>
          )}
          {detail && reviews.length === 0 && <p className="cws-empty">まだレビューはありません。</p>}
        </section>
      )}

      {tab === "author" && studio && detail && (
        <section className="cws-panel">
          <div className="cws-author-card">
            <span className="cws-avatar cws-avatar-lg">{detail.creator.name.slice(0, 1) || "?"}</span>
            <div className="cws-author-card-text">
              <strong>{detail.creator.name}</strong>
              <span className="cws-hero-rating">
                <Stars value={detail.creator.rating.avg} size={13} />
                <b>{detail.creator.rating.count > 0 ? detail.creator.rating.avg.toFixed(1) : "—"}</b>
                <span>（作者の全作品 {detail.creator.rating.count} 件のレビュー）</span>
              </span>
              <span className="cws-muted">販売中の作品 {detail.creator.workCount} 件</span>
            </div>
          </div>
          <button type="button" className="cws-outline cws-block" onClick={() => onOpenAuthor(detail.creator.id)}>
            作者のページを見る
          </button>
        </section>
      )}
      {running && <ExtensionRunner workId={workId} name={item.name} onClose={() => setRunning(false)} />}
    </div>
  );
}

// 星の集計（平均と、星ごとの件数の棒グラフ）
function ReviewSummary({ rating }: { rating: RatingSummary }) {
  const max = Math.max(1, ...rating.distribution);
  return (
    <div className="cws-summary">
      <div className="cws-summary-score">
        <strong>{rating.count > 0 ? rating.avg.toFixed(1) : "—"}</strong>
        <Stars value={rating.avg} size={14} />
        <span>{rating.count}件のレビュー</span>
      </div>
      <ol className="cws-bars" aria-label="星ごとの件数">
        {[5, 4, 3, 2, 1].map((n) => {
          const count = rating.distribution[n - 1] ?? 0;
          return (
            <li key={n}>
              <span>{n}</span>
              <span className="cws-bar">
                <span style={{ width: `${(count / max) * 100}%` }} />
              </span>
              <span className="cws-bar-count">{count}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// レビューを書く・直す・消す（買った人だけ。作者本人は書けない）
function ReviewForm({
  workId,
  canReview,
  isMine,
  owned,
  myReview,
  onSaved
}: {
  workId: string;
  canReview: boolean;
  isMine: boolean;
  owned: boolean;
  myReview: ReviewView | null;
  onSaved: () => void;
}) {
  const [rating, setRating] = useState(myReview?.rating ?? 0);
  const [comment, setComment] = useState(myReview?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  if (isMine) return <p className="cws-hint">作者は自分の作品にレビューできません。</p>;
  if (!canReview) {
    return <p className="cws-hint">{owned ? "" : "この作品を買うと、星とコメントを付けられます。"}</p>;
  }

  const submit = async () => {
    setError("");
    setDone("");
    if (rating < 1) {
      setError("星を選んでください。");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/studio/works/${workId}/review`, post({ rating, comment: comment.trim() }));
      setDone(myReview ? "レビューを更新しました。" : "レビューを投稿しました。ありがとうございます。");
      onSaved();
    } catch (e) {
      setError(errorText(e, "レビューを投稿できませんでした。"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/studio/works/${workId}/review`, delete_());
      setRating(0);
      setComment("");
      setDone("レビューを削除しました。");
      onSaved();
    } catch (e) {
      setError(errorText(e, "レビューを削除できませんでした。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cws-review-form">
      <strong className="cws-subheading-inline">{myReview ? "あなたのレビュー" : "レビューを書く"}</strong>
      <StarPicker value={rating} onChange={setRating} disabled={busy} />
      <label className="cws-field">
        <span className="cws-muted">コメント（任意・1000文字まで）</span>
        <textarea
          rows={3}
          maxLength={1000}
          value={comment}
          disabled={busy}
          onChange={(e) => setComment(e.target.value)}
          placeholder="使ってみた感想を書いてください（URL・連絡先は書けません）"
        />
      </label>
      {error && <p className="cws-error-inline">{error}</p>}
      {done && !error && <p className="cws-ok-inline">{done}</p>}
      <div className="cws-form-actions">
        {myReview && (
          <button type="button" className="cws-text-btn danger" disabled={busy} onClick={() => void remove()}>
            レビューを削除
          </button>
        )}
        <button type="button" className="cws-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "送信しています…" : myReview ? "レビューを更新" : "投稿する"}
        </button>
      </div>
    </div>
  );
}

function ReviewItem({ review }: { review: ReviewView }) {
  const edited = review.updatedAt !== review.createdAt;
  return (
    <li className="cws-review">
      <div className="cws-review-head">
        <span className="cws-avatar">{review.reviewerName.slice(0, 1) || "?"}</span>
        <div className="cws-review-who">
          <strong>
            {review.reviewerName || "ユーザー"}
            {review.mine && <em className="cws-mine">あなた</em>}
          </strong>
          <small>
            {dateText(review.updatedAt)}
            {edited ? "（編集済み）" : ""}
          </small>
        </div>
      </div>
      <Stars value={review.rating} size={12} />
      {review.comment && <p className="cws-review-text">{review.comment}</p>}
    </li>
  );
}
