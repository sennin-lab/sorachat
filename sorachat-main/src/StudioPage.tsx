import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon, type IconName } from "./Icon";
import { Page } from "./Page";
import { storeAuthorPath, storeItemPath } from "./StorePage";
import { StudioEditor } from "./StudioEditor";
import { Stars, dateText, errorText, KIND_LABEL, WorkIcon, yen } from "./storeUi";
import type { CreatorView, PayoutView, StudioMeView, StudioWorkView } from "./types";

// senninstudio の開発者ダッシュボード（/studio）。概要・作品・レビュー・支払い・ドキュメントと、作品の作成・編集。
// 作者ができるのは「公開」「編集」「削除」だけ。停止・復帰・支払いの再送は管理者が行う。
const LINK_HREF = "/api/auth/sennin/link?from=studio";

type Section =
  | { name: "overview" }
  | { name: "works" }
  | { name: "reviews" }
  | { name: "payments" }
  | { name: "docs" }
  | { name: "new" }
  | { name: "edit"; id: string };

export function parseStudioRoute(path: string): Section {
  const edit = /^\/studio\/works\/([^/]+)\/edit\/?$/.exec(path);
  if (edit) return { name: "edit", id: decodeURIComponent(edit[1]) };
  const top = /^\/studio\/([a-z]+)\/?$/.exec(path);
  if (top) {
    const name = top[1];
    if (name === "works" || name === "reviews" || name === "payments" || name === "docs" || name === "new") return { name };
  }
  return { name: "overview" };
}

const NAV: { to: string; name: Section["name"]; label: string; icon: IconName }[] = [
  { to: "/studio", name: "overview", label: "概要", icon: "grid" },
  { to: "/studio/works", name: "works", label: "作品", icon: "store" },
  { to: "/studio/reviews", name: "reviews", label: "レビュー", icon: "star" },
  { to: "/studio/payments", name: "payments", label: "支払い", icon: "wallet" },
  { to: "/studio/docs", name: "docs", label: "ドキュメント", icon: "book" }
];

const STATUS_TEXT = (w: StudioWorkView) => {
  if (w.status === "published") return { text: "販売中", tone: "ok" };
  if (w.status === "deleted") return { text: "削除済み", tone: "muted" };
  if (w.hiddenReason === "reports") return { text: "通報で自動非公開", tone: "ng" };
  if (w.hiddenReason === "creator_suspended") return { text: "作者の停止中", tone: "ng" };
  return { text: "運営により非公開", tone: "ng" };
};

const PAYOUT_TEXT: Record<PayoutView["status"], { text: string; tone: string }> = {
  paid: { text: "支払い済み", tone: "ok" },
  pending: { text: "保留（連携後に払います）", tone: "muted" },
  failed: { text: "失敗（運営が再送します）", tone: "ng" }
};

export function StudioPage({ flash, onBack }: { flash?: { ok: boolean; text: string } | null; onBack: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const section = useMemo(() => parseStudioRoute(location.pathname), [location.pathname]);

  const [data, setData] = useState<StudioMeView | null>(null);
  const [creator, setCreator] = useState<CreatorView | null>(null);
  const [payouts, setPayouts] = useState<PayoutView[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(flash ?? null);
  const [toDelete, setToDelete] = useState<StudioWorkView | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "published" | "hidden" | "deleted">("all");

  // 連携から戻った結果は、ページが開いたあとに届くことがあるので、届いたら表示する
  useEffect(() => {
    if (flash) setNotice(flash);
  }, [flash]);

  const load = useCallback(async () => {
    try {
      const me = await api<StudioMeView>("/api/studio/me");
      setData(me);
      setLoadError("");
      // 作者の評価・レビュー（作者のページの情報）と、支払いの一覧も取り直す
      const [profile, list] = await Promise.all([
        api<CreatorView>(`/api/studio/creators/${me.userId}`).catch(() => null),
        api<{ payouts: PayoutView[] }>("/api/studio/payouts").catch(() => null)
      ]);
      setCreator(profile);
      setPayouts(list?.payouts ?? null);
    } catch (e) {
      setLoadError(errorText(e, "作者の情報を読み込めませんでした。"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canCreate = Boolean(data?.linked && !data?.suspended);
  const works = data?.works ?? [];
  const totals = useMemo(() => {
    const sales = works.reduce((sum, w) => sum + w.sales, 0);
    return {
      sales,
      published: works.filter((w) => w.status === "published").length,
      hidden: works.filter((w) => w.status === "hidden").length,
      deleted: works.filter((w) => w.status === "deleted").length
    };
  }, [works]);

  const remove = async (work: StudioWorkView) => {
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/studio/works/${work.id}`, { method: "DELETE" });
      setNotice({ ok: true, text: `「${work.name}」を削除しました。すでに買った人は引き続き使えます。` });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "削除できませんでした。") });
    } finally {
      setBusy(false);
      setToDelete(null);
      void load();
    }
  };

  const goBack = () => {
    if (section.name === "new" || section.name === "edit") navigate("/studio/works", { replace: true });
    else if (section.name !== "overview") navigate("/studio", { replace: true });
    else onBack();
  };

  const editing = section.name === "edit" ? (works.find((w) => w.id === section.id) ?? null) : null;
  const pageTitle = section.name === "new" ? "新しい作品" : section.name === "edit" ? "作品を編集" : "senninstudio";
  const sectionLabel = NAV.find((n) => n.name === section.name)?.label ?? "";

  return (
    <>
      <Page title={pageTitle} onBack={goBack} wide>
        <div className="dev">
          <nav className="dev-nav" aria-label="開発者メニュー">
            <div className="dev-account">
              <span className="cws-avatar">{(creator?.name ?? "?").slice(0, 1)}</span>
              <div className="dev-account-text">
                <strong>{creator?.name ?? "作者"}</strong>
                <small>{!data ? "読み込み中" : !data.linked ? "未連携" : data.suspended ? "公開停止中" : "作者アカウント"}</small>
              </div>
            </div>
            <button type="button" className="cws-primary dev-new" disabled={!canCreate} onClick={() => navigate("/studio/new")}>
              <Icon name="plus" size={16} /> 新しい作品
            </button>
            <ul className="dev-nav-list">
              {NAV.map((item) => (
                <li key={item.to}>
                  <button
                    type="button"
                    className={`dev-nav-item${section.name === item.name ? " on" : ""}`}
                    onClick={() => navigate(item.to)}
                    aria-current={section.name === item.name ? "page" : undefined}
                  >
                    <Icon name={item.icon} size={18} />
                    <span>{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
            {data?.linked && creator && (
              <button type="button" className="dev-nav-link" onClick={() => navigate(storeAuthorPath(creator.id))}>
                作者ページを見る <Icon name="external" size={14} />
              </button>
            )}
          </nav>

          <main className="dev-main">
            {loadError && <p className="cws-error">{loadError}</p>}
            {notice && (
              <p className={`cws-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
                {notice.text}
              </p>
            )}
            {!data && !loadError && <p className="cws-empty">読み込み中…</p>}

            {data && section.name !== "new" && section.name !== "edit" && (
              <header className="dev-head">
                <h2>{sectionLabel}</h2>
                {section.name === "overview" && <p>作品の公開・販売・レビュー・支払いをここで管理します。</p>}
              </header>
            )}

            {data && !data.linked && section.name !== "docs" && (
              <section className="dev-banner">
                <div>
                  <strong>作者になるには、仙人アカウントと連携してください</strong>
                  <p>作品を公開して売るには連携が必要です。売上は仙人アカウントのポイントで受け取ります（手数料はかかりません）。</p>
                </div>
                <a className="cws-primary" href={LINK_HREF}>
                  仙人アカウントと連携する
                </a>
              </section>
            )}
            {data && data.suspended && (
              <p className="cws-notice is-ng">
                この作者アカウントは作品の公開を停止されています。{data.suspendedReason ? `（理由: ${data.suspendedReason}）` : ""}
              </p>
            )}

            {data && section.name === "overview" && (
              <>
                <div className="dev-kpis">
                  <div className="dev-kpi">
                    <span>受け取った売上</span>
                    <strong>{yen(data.earned)} pt</strong>
                  </div>
                  <div className="dev-kpi">
                    <span>未払い</span>
                    <strong>{yen(data.pending)} pt</strong>
                  </div>
                  <div className="dev-kpi">
                    <span>株主配当で引いた額</span>
                    <strong>{yen(data.dividendWithheld ?? 0)} pt</strong>
                    <small>売上 {yen(data.grossSales ?? 0)} pt のうち</small>
                  </div>
                  <div className="dev-kpi">
                    <span>平均評価</span>
                    <strong>{creator && creator.rating.count > 0 ? creator.rating.avg.toFixed(1) : "—"}</strong>
                    <small>{creator?.rating.count ?? 0} 件のレビュー</small>
                  </div>
                  <div className="dev-kpi">
                    <span>購入の合計</span>
                    <strong>{totals.sales.toLocaleString("ja-JP")}</strong>
                    <small>件</small>
                  </div>
                </div>
                {data.pending > 0 && (
                  <p className="dev-muted">未払いは、仙人アカウントの連携が有効なときに自動で払われます。払えないときは保留になります。</p>
                )}

                <div className="dev-two">
                  <section className="dev-panel">
                    <h3>作品の状況</h3>
                    <dl className="dev-stats">
                      <div>
                        <dt>販売中</dt>
                        <dd>{totals.published}</dd>
                      </div>
                      <div>
                        <dt>非公開</dt>
                        <dd>{totals.hidden}</dd>
                      </div>
                      <div>
                        <dt>削除済み</dt>
                        <dd>{totals.deleted}</dd>
                      </div>
                    </dl>
                    <button type="button" className="cws-outline cws-block" onClick={() => navigate("/studio/works")}>
                      作品を管理する
                    </button>
                  </section>

                  <section className="dev-panel">
                    <h3>最近のレビュー</h3>
                    {!creator || creator.reviews.length === 0 ? (
                      <p className="dev-muted">まだレビューはありません。</p>
                    ) : (
                      <ul className="dev-mini-reviews">
                        {creator.reviews.slice(0, 4).map((r, i) => (
                          <li key={`${r.workId}-${i}`}>
                            <Stars value={r.rating} size={11} />
                            <span>{r.workName}</span>
                            <small>{dateText(r.updatedAt)}</small>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button type="button" className="cws-outline cws-block" onClick={() => navigate("/studio/reviews")}>
                      すべてのレビュー
                    </button>
                  </section>
                </div>
              </>
            )}

            {data && section.name === "works" && (
              <>
                <div className="dev-toolbar">
                  <div className="dev-filter" role="tablist" aria-label="作品の状態">
                    {(
                      [
                        ["all", `すべて ${works.length}`],
                        ["published", `販売中 ${totals.published}`],
                        ["hidden", `非公開 ${totals.hidden}`],
                        ["deleted", `削除済み ${totals.deleted}`]
                      ] as const
                    ).map(([id, label]) => (
                      <button key={id} type="button" role="tab" aria-selected={filter === id} className={`cws-cat${filter === id ? " on" : ""}`} onClick={() => setFilter(id)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {works.length === 0 ? (
                  <p className="cws-empty">まだ作品がありません。「新しい作品」から最初の作品を公開しましょう。</p>
                ) : (
                  <div className="dev-table" role="table" aria-label="作品の一覧">
                    <div className="dev-row dev-row-head" role="row">
                      <span role="columnheader">作品</span>
                      <span role="columnheader">価格</span>
                      <span role="columnheader">評価</span>
                      <span role="columnheader">販売</span>
                      <span role="columnheader">状態</span>
                      <span role="columnheader">操作</span>
                    </div>
                    {works
                      .filter((w) => filter === "all" || w.status === filter)
                      .map((work) => {
                        const status = STATUS_TEXT(work);
                        return (
                          <div key={work.id} className="dev-row" role="row">
                            <span className="dev-cell-work" role="cell">
                              <WorkIcon item={{ thumbUrl: work.thumbUrl, kind: "extension", studioKind: work.kind }} size={40} />
                              <span>
                                <strong>{work.name}</strong>
                                <small>
                                  {KIND_LABEL[work.kind]} ・ 更新 {dateText(work.editedAt ?? work.createdAt)}
                                </small>
                              </span>
                            </span>
                            <span role="cell" className="dev-num">
                              <span className="dev-label">価格</span>
                              {yen(work.price)} pt
                            </span>
                            <span role="cell" className="dev-num">
                              <span className="dev-label">評価</span>
                              {work.rating.count > 0 ? (
                                <>
                                  {work.rating.avg.toFixed(1)} <small>({work.rating.count})</small>
                                </>
                              ) : (
                                <small>なし</small>
                              )}
                            </span>
                            <span role="cell" className="dev-num">
                              <span className="dev-label">販売</span>
                              {work.sales}
                            </span>
                            <span role="cell">
                              <span className="dev-label">状態</span>
                              <span className={`dev-status is-${status.tone}`}>{status.text}</span>
                            </span>
                            <span role="cell" className="dev-cell-actions">
                              {work.status !== "deleted" && (
                                <button type="button" className="cws-outline cws-small" onClick={() => navigate(`/studio/works/${work.id}/edit`)}>
                                  編集
                                </button>
                              )}
                              {work.status === "published" && (
                                <button type="button" className="cws-outline cws-small" onClick={() => navigate(storeItemPath(`work:${work.id}`))}>
                                  掲載ページ
                                </button>
                              )}
                              {work.status !== "deleted" && (
                                <button type="button" className="cws-text-btn danger" onClick={() => setToDelete(work)} disabled={busy}>
                                  削除
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                )}
              </>
            )}

            {data && section.name === "reviews" && (
              <>
                <section className="dev-panel">
                  <div className="cws-summary">
                    <div className="cws-summary-score">
                      <strong>{creator && creator.rating.count > 0 ? creator.rating.avg.toFixed(1) : "—"}</strong>
                      <Stars value={creator?.rating.avg ?? 0} size={14} />
                      <span>{creator?.rating.count ?? 0} 件のレビュー（作者の全作品）</span>
                    </div>
                    <ol className="cws-bars">
                      {[5, 4, 3, 2, 1].map((n) => {
                        const count = creator?.rating.distribution[n - 1] ?? 0;
                        const max = Math.max(1, ...(creator?.rating.distribution ?? [1]));
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
                </section>
                {!creator || creator.reviews.length === 0 ? (
                  <p className="cws-empty">まだレビューはありません。作品が買われて、レビューが付くとここに並びます。</p>
                ) : (
                  <ul className="cws-reviews">
                    {creator.reviews.map((r, i) => (
                      <li key={`${r.workId}-${i}`} className="cws-review">
                        <div className="cws-review-head">
                          <span className="cws-avatar">{r.reviewerName.slice(0, 1) || "?"}</span>
                          <div className="cws-review-who">
                            <strong>{r.reviewerName || "ユーザー"}</strong>
                            <small>
                              {dateText(r.updatedAt)} ・ {r.workName}
                            </small>
                          </div>
                        </div>
                        <Stars value={r.rating} size={12} />
                        {r.comment && <p className="cws-review-text">{r.comment}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {data && section.name === "payments" && (
              <>
                <div className="dev-kpis dev-kpis-2">
                  <div className="dev-kpi">
                    <span>受け取った売上</span>
                    <strong>{yen(data.earned)} pt</strong>
                  </div>
                  <div className="dev-kpi">
                    <span>未払い</span>
                    <strong>{yen(data.pending)} pt</strong>
                  </div>
                  <div className="dev-kpi">
                    <span>株主配当で引いた額</span>
                    <strong>{yen(data.dividendWithheld ?? 0)} pt</strong>
                    <small>売上 {yen(data.grossSales ?? 0)} pt のうち</small>
                  </div>
                </div>
                <p className="dev-muted">購入のたびに、作品の価格の全額が支払いとして記録されます（手数料はありません）。</p>
                {!payouts || payouts.length === 0 ? (
                  <p className="cws-empty">まだ支払いはありません。</p>
                ) : (
                  <div className="dev-table" role="table" aria-label="支払いの一覧">
                    <div className="dev-row dev-row-head dev-row-pay" role="row">
                      <span role="columnheader">日付</span>
                      <span role="columnheader">作品</span>
                      <span role="columnheader">金額</span>
                      <span role="columnheader">状態</span>
                    </div>
                    {payouts.map((p) => (
                      <div key={p.id} className="dev-row dev-row-pay" role="row">
                        <span role="cell">
                          <span className="dev-label">日付</span>
                          {dateText(p.createdAt)}
                        </span>
                        <span role="cell">
                          <span className="dev-label">作品</span>
                          {p.workName}
                        </span>
                        <span role="cell" className="dev-num">
                          <span className="dev-label">金額</span>
                          {yen(p.amount)} pt
                        </span>
                        <span role="cell">
                          <span className="dev-label">状態</span>
                          <span className={`dev-status is-${PAYOUT_TEXT[p.status].tone}`}>{PAYOUT_TEXT[p.status].text}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {section.name === "docs" && <StudioDocs />}

            {data && section.name === "new" && (
              <StudioEditor
                mode="create"
                initial={null}
                onCancel={() => navigate("/studio/works")}
                onDone={(text) => {
                  setNotice({ ok: true, text });
                  navigate("/studio/works", { replace: true });
                  void load();
                }}
              />
            )}

            {data &&
              section.name === "edit" &&
              (editing ? (
                <StudioEditor
                  key={editing.id}
                  mode="edit"
                  initial={editing}
                  onCancel={() => navigate("/studio/works")}
                  onDone={(text) => {
                    setNotice({ ok: true, text });
                    navigate("/studio/works", { replace: true });
                    void load();
                  }}
                />
              ) : (
                <p className="cws-empty">この作品は見つかりませんでした。</p>
              ))}
          </main>
        </div>
      </Page>

      {toDelete && (
        <ConfirmDialog
          title="作品を削除しますか？"
          message={`「${toDelete.name}」の販売をやめます。すでに買った人は引き続き使えます。削除は取り消せません。`}
          confirmLabel="削除する"
          danger
          busy={busy}
          onConfirm={() => void remove(toDelete)}
          onCancel={() => setToDelete(null)}
        />
      )}
    </>
  );
}

// 開発者ドキュメント（作品の種類・公開の自動チェック・価格と支払い・編集・レビュー・通報）
function StudioDocs() {
  const items: { title: string; body: string[] }[] = [
    {
      title: "はじめに",
      body: [
        "作品の公開には、仙人アカウントとの連携が必要です。連携すると、作者として作品を公開・編集・削除できます。審査はなく、公開のときに自動チェックを通ったものだけが公開されます。",
        "1人が1日に公開できる作品は20件までです。"
      ]
    },
    {
      title: "作品の種類",
      body: [
        "スタンプパック：PNG・GIF・WebP の画像を 1〜24 枚。縦横とも 16〜512px、1 枚 1MB まで。サムネイルを省略すると 1 枚目を使います。",
        "外観：自分の吹き出し・チャットの背景・ボタンの 3 色（#RRGGBB）。買った人は自分の画面だけで使えます。",
        "クイズ：4 択の問題を 5〜50 問。対戦では 5 問ずつランダムに出題され、選択肢の順番もばらされます。",
        "応答スタイル：senninai の口調・長さ・絵文字の使い方を選びます。自由文の指示は入れられません。"
      ]
    },
    {
      title: "公開の自動チェック",
      body: [
        "URL・メールアドレス・電話番号らしいもの、禁止語を含む名前・説明・問題は公開できません。画像は拡張子ではなく中身で形式と大きさを判定します。",
        "作品のエディタの「公開前チェック」で、サーバーと同じ条件を先に確かめられます。"
      ]
    },
    {
      title: "価格と支払い",
      body: [
        "価格は 10〜1000 pt の整数です。手数料はなく、購入額の全額が作者の仙人アカウントに入ります。",
        "購入のたびに支払いを 1 件記録します。作者が未連携のあいだは保留になり、連携したときに自動で払われます。失敗したときは運営が再送できます。"
      ]
    },
    {
      title: "編集のルール",
      body: [
        "名前・説明・価格・サムネイルは、いつでも変えられます。外観の色・クイズの問題・応答スタイルも変えられます。変更は、買った人の画面にも反映されます。",
        "スタンプ画像と作品の種類は、買った人の手元に残るため変えられません。作り直して公開してください。",
        "価格を変えても、すでに買った人の支払いは変わりません。"
      ]
    },
    {
      title: "レビューと評価",
      body: [
        "レビューは、その作品を買った人だけが書けます（作者本人は不可）。星は 1〜5 で、コメントは 1000 文字まで。1 人 1 作品につき 1 件で、あとから直したり消したりできます。",
        "作者の評価は、作者の全作品のレビューの平均です。評価は作品の一覧と掲載ページ、作者のページに表示されます。"
      ]
    },
    {
      title: "通報と非公開",
      body: [
        "買った人や見た人は、作品を通報できます（1 人 1 回）。通報が 5 件たまると、自動で非公開になります。",
        "非公開になっても、すでに買った人は引き続き使えます。運営は作品の公開・非公開・削除と、作者の停止を管理します。"
      ]
    },
    {
      title: "削除",
      body: ["作者は作品を削除すると、販売をやめられます。削除しても、すでに買った人は引き続き使えます。削除は取り消せません。"]
    }
  ];
  return (
    <div className="dev-docs">
      <p className="dev-muted">senninstudio の仕組みと、作者が守ること・できることをまとめています。</p>
      {items.map((item) => (
        <section key={item.title} className="dev-doc">
          <h3>{item.title}</h3>
          {item.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
      ))}
      <ExtensionSpec />
    </div>
  );
}

// 拡張機能の仕様（AI に渡せる文書）。サーバーの定数（上限・窓口の名前・エラーの code）から作るので、ここには手で書かない
function ExtensionSpec() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/studio/extensions/spec", { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((body) => {
        if (alive) setText(body);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="dev-doc dev-spec">
      <h3>拡張機能の仕様（AI に渡す文書）</h3>
      <p>
        ポイントを配るゲームなどを作るときは、この文書を AI に渡してください。配れる上限・窓口の名前・エラーの code は、ソラチャットの実際の仕様から自動で作られます。
      </p>
      <div className="dev-spec-actions">
        <button type="button" className="btn-small" onClick={copy} disabled={!text}>
          {copied ? "コピーしました" : "文書をコピー"}
        </button>
      </div>
      {failed ? (
        <p className="notice error">仕様を読み込めませんでした。時間をおいてお試しください。</p>
      ) : text === null ? (
        <p className="dev-muted">読み込み中…</p>
      ) : (
        <pre className="dev-spec-text">{text}</pre>
      )}
    </section>
  );
}
