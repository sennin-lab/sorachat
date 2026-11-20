import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api";
import { Stars, WorkIcon, dateText, errorText, KIND_LABEL, yen } from "./storeUi";
import type { CreatorView, Me } from "./types";

// 作者のページ（ストアの「作者」から開く）。作者の評価・販売中の作品・最近のレビューを見られる
export function StoreAuthor({ creatorId, me, onOpenItem }: { creatorId: string; me: Me; onOpenItem: (itemId: string) => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<CreatorView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api<CreatorView>(`/api/studio/creators/${creatorId}`)
      .then((next) => {
        if (!alive) return;
        setData(next);
        setError("");
      })
      .catch((e) => {
        if (alive) setError(errorText(e, "作者のページを読み込めませんでした。"));
      });
    return () => {
      alive = false;
    };
  }, [creatorId]);

  if (error) return <p className="cws-error">{error}</p>;
  if (!data) return <p className="cws-empty">読み込み中…</p>;

  const isMe = data.id === me.id;
  const initial = data.name.slice(0, 1) || "?";

  return (
    <div className="cws-author">
      <header className="cws-author-head">
        <span className="cws-avatar cws-avatar-xl">{initial}</span>
        <div className="cws-author-head-text">
          <h1>{data.name}</h1>
          <span className="cws-muted">
            仙人ストアの作者 ・ {dateText(data.createdAt)} から
          </span>
          {isMe && (
            <button type="button" className="cws-outline cws-author-edit" onClick={() => navigate("/studio")}>
              開発者ダッシュボードを開く
            </button>
          )}
        </div>
      </header>

      <section className="cws-stat-row" aria-label="作者の数字">
        <div>
          <span>平均評価</span>
          <strong>
            {data.rating.count > 0 ? data.rating.avg.toFixed(1) : "—"}
          </strong>
          <Stars value={data.rating.avg} size={12} />
        </div>
        <div>
          <span>レビュー</span>
          <strong>{data.rating.count.toLocaleString("ja-JP")}</strong>
          <small>件</small>
        </div>
        <div>
          <span>販売中の作品</span>
          <strong>{data.workCount.toLocaleString("ja-JP")}</strong>
          <small>件</small>
        </div>
        <div>
          <span>購入</span>
          <strong>{data.sales.toLocaleString("ja-JP")}</strong>
          <small>件</small>
        </div>
      </section>

      <h2 className="cws-heading">作品 <span>{data.works.length}件</span></h2>
      {data.works.length === 0 ? (
        <p className="cws-empty">販売中の作品はありません。</p>
      ) : (
        <ul className="cws-grid">
          {data.works.map((work) => (
            <li key={work.id} className="cws-card">
              <button type="button" className="cws-card-open" onClick={() => onOpenItem(`work:${work.id}`)}>
                <WorkIcon item={{ thumbUrl: work.thumbUrl, kind: "extension", studioKind: work.kind }} size={56} />
                <span className="cws-card-body">
                  <strong className="cws-card-title">{work.name}</strong>
                  <span className="cws-kind">{KIND_LABEL[work.kind]}</span>
                  <span className="cws-rating-line">
                    {work.rating.count > 0 ? <Stars value={work.rating.avg} size={12} /> : null}
                    <span>{work.rating.count > 0 ? `${work.rating.avg.toFixed(1)}（${work.rating.count}件）` : "レビューなし"}</span>
                  </span>
                </span>
              </button>
              <div className="cws-card-foot">
                <span className="cws-price">{yen(work.price)} pt</span>
                <span className="cws-muted">{work.sales} 件購入</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="cws-heading">最近のレビュー</h2>
      {data.reviews.length === 0 ? (
        <p className="cws-empty">まだレビューはありません。</p>
      ) : (
        <ul className="cws-reviews">
          {data.reviews.map((review, i) => (
            <li key={`${review.workId}-${i}`} className="cws-review">
              <div className="cws-review-head">
                <span className="cws-avatar">{review.reviewerName.slice(0, 1) || "?"}</span>
                <div className="cws-review-who">
                  <strong>{review.reviewerName || "ユーザー"}</strong>
                  <small>
                    {dateText(review.updatedAt)} ・ <button type="button" className="cws-link-btn" onClick={() => onOpenItem(`work:${review.workId}`)}>{review.workName}</button>
                  </small>
                </div>
              </div>
              <Stars value={review.rating} size={12} />
              {review.comment && <p className="cws-review-text">{review.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
