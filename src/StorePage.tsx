import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, post } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Page } from "./Page";
import { StoreAuthor } from "./StoreAuthor";
import { StoreDetail } from "./StoreDetail";
import { Stars, WorkIcon, errorText, kindLabelOf, ratingLabel, yen } from "./storeUi";
import type { Me, StoreItemView, StoreView } from "./types";

// 通報の対象（作品）
type ReportTarget = { id: string; name: string };
type Flash = { ok: boolean; text: string };
type Route = { name: "list" } | { name: "item"; id: string } | { name: "author"; id: string };

// 仙人アカウントの連携は、今のソラチャットアカウントに紐づける（ユーザー名・パスワードで作った人も可）
const LINK_HREF = "/api/auth/sennin/link?from=store";

// 掲載ページ・作者ページのURL（ストアの中の移動に使う）
export const storeItemPath = (itemId: string) => `/store/item/${encodeURIComponent(itemId)}`;
export const storeAuthorPath = (creatorId: string) => `/store/author/${encodeURIComponent(creatorId)}`;

export function parseStoreRoute(path: string): Route {
  const item = /^\/store\/item\/(.+?)\/?$/.exec(path);
  if (item) return { name: "item", id: decodeURIComponent(item[1]) };
  const author = /^\/store\/author\/(.+?)\/?$/.exec(path);
  if (author) return { name: "author", id: decodeURIComponent(author[1]) };
  return { name: "list" };
}

// 一覧の絞り込み（上のタブ）
const CATEGORIES: { id: string; label: string; match: (item: StoreItemView) => boolean }[] = [
  { id: "all", label: "すべて", match: () => true },
  { id: "theme", label: "外観", match: (i) => i.kind === "theme" },
  { id: "stamp", label: "スタンプ", match: (i) => i.kind === "stamp_pack" },
  { id: "quiz", label: "クイズ", match: (i) => i.studioKind === "quiz" },
  { id: "style", label: "応答スタイル", match: (i) => i.studioKind === "ai_style" },
  { id: "ext", label: "拡張機能", match: (i) => i.kind === "extension" && !i.studioKind }
];

const SORTS = [
  { id: "new", label: "新着順" },
  { id: "rating", label: "評価の高い順" },
  { id: "sales", label: "購入の多い順" },
  { id: "price", label: "価格の安い順" }
] as const;
type Sort = (typeof SORTS)[number]["id"];

// 仙人ストア（/store・/store/item/:id・/store/author/:id）。Chrome ウェブストアのような一覧と掲載ページ。
// 未連携のときは、まず連携を案内する。購入・外観・応答スタイル・通報は、このページで行う。
export function StorePage({
  me,
  flash,
  onBack,
  onMeChange
}: {
  me: Me;
  flash?: Flash | null;
  onBack: () => void;
  onMeChange: (next: Me) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const route = useMemo(() => parseStoreRoute(location.pathname), [location.pathname]);

  const [view, setView] = useState<StoreView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [points, setPoints] = useState<number | null>(null);
  const [pointsBusy, setPointsBusy] = useState(false);
  const [pointsError, setPointsError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<StoreItemView | null>(null);
  const [notice, setNotice] = useState<Flash | null>(flash ?? null);
  const [unlinking, setUnlinking] = useState(false);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<Sort>("new");
  const [query, setQuery] = useState("");

  // 連携から戻った結果は、ページが開いたあとに届くことがあるので、届いたら表示する
  useEffect(() => {
    if (flash) setNotice(flash);
  }, [flash]);

  const loadView = useCallback(async (): Promise<StoreView | null> => {
    try {
      const next = await api<StoreView>("/api/store");
      setView(next);
      setLoadError("");
      return next;
    } catch (e) {
      setLoadError(errorText(e, "ストアを読み込めませんでした。"));
      return null;
    }
  }, []);

  const loadPoints = useCallback(async () => {
    setPointsBusy(true);
    setPointsError("");
    try {
      const result = await api<{ points: number }>("/api/store/balance");
      setPoints(result.points);
    } catch (e) {
      setPoints(null);
      setPointsError(errorText(e, "ポイントを取得できませんでした。"));
      // 連携が切れていたら、連携の案内に切り替える
      void loadView();
    } finally {
      setPointsBusy(false);
    }
  }, [loadView]);

  useEffect(() => {
    void loadView().then((next) => {
      if (next?.linked) void loadPoints();
    });
  }, [loadView, loadPoints]);

  const linked = view?.linked ?? false;

  const buy = async (item: StoreItemView) => {
    setBusyId(item.id);
    setNotice(null);
    try {
      const result = await api<{ points: number }>("/api/store/purchase", post({ itemId: item.id }));
      setPoints(result.points);
      setNotice({ ok: true, text: `「${item.name}」を購入しました。` });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "購入できませんでした。") });
    } finally {
      setBusyId(null);
      setConfirm(null);
      void loadView();
    }
  };

  const useTheme = async (itemId: string | null) => {
    setBusyId(itemId ?? "default");
    setNotice(null);
    try {
      const result = await api<{ storeTheme: string | null }>("/api/store/theme", post({ itemId }));
      // 画面の外観は、すぐ切り替える（App 側の情報も更新する）
      onMeChange({ ...me, storeTheme: result.storeTheme });
      await loadView();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "外観を変えられませんでした。") });
    } finally {
      setBusyId(null);
    }
  };

  // senninai の応答スタイル（作品）を使う・やめる
  const useAiStyle = async (itemId: string | null) => {
    setBusyId(itemId ?? "default");
    setNotice(null);
    try {
      await api("/api/store/ai-style", post({ itemId }));
      await loadView();
      setNotice({ ok: true, text: itemId ? "応答スタイルを変えました。senninai の次の回答から反映されます。" : "応答スタイルを標準に戻しました。" });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "応答スタイルを変えられませんでした。") });
    } finally {
      setBusyId(null);
    }
  };

  // 作品を通報する（1人1回。5件たまると自動で非公開になる）
  const report = async (target: ReportTarget) => {
    setNotice(null);
    try {
      await api(`/api/studio/works/${target.id}/report`, post({ reason: "" }));
      setNotice({ ok: true, text: `「${target.name}」を通報しました。ご協力ありがとうございます。` });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "通報できませんでした。") });
    } finally {
      setReportTarget(null);
    }
  };

  const unlink = async () => {
    setUnlinking(true);
    setNotice(null);
    try {
      await api("/api/store/unlink", post());
      setPoints(null);
      setNotice({ ok: true, text: "仙人アカウントの連携を解除しました。" });
      await loadView();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "連携を解除できませんでした。") });
    } finally {
      setUnlinking(false);
    }
  };

  const goBack = () => {
    if (route.name === "list") onBack();
    else navigate("/store", { replace: true });
  };

  const allItems = view?.items ?? [];
  const shown = useMemo(() => {
    const tab = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];
    const q = query.trim().toLowerCase();
    const filtered = allItems.filter(
      (item) =>
        tab.match(item) &&
        (!q || item.name.toLowerCase().includes(q) || (item.creatorName ?? "").toLowerCase().includes(q) || item.description.toLowerCase().includes(q))
    );
    return [...filtered].sort((a, b) => {
      if (sort === "rating") return (b.rating?.avg ?? 0) - (a.rating?.avg ?? 0) || (b.rating?.count ?? 0) - (a.rating?.count ?? 0);
      if (sort === "sales") return (b.sales ?? 0) - (a.sales ?? 0);
      if (sort === "price") return a.price - b.price;
      return 0; // 新着順（サーバーの順番のまま）
    });
  }, [allItems, category, query, sort]);

  const openItem = (item: StoreItemView) => navigate(storeItemPath(item.id));

  const routeItem = route.name === "item" ? allItems.find((i) => i.id === route.id) ?? null : null;
  const pageTitle = route.name === "item" ? (routeItem?.name ?? "商品の詳細") : route.name === "author" ? "作者のページ" : "仙人ストア";

  // 購入・追加の表示（一覧と掲載ページで共通）
  const renderBuyButton = (item: StoreItemView, compact: boolean) => {
    if (item.owned) {
      return (
        <span className="cws-owned">
          <Icon name="check" size={16} /> 追加済み
        </span>
      );
    }
    if (!linked) {
      return (
        <a className={`cws-add${compact ? " is-compact" : ""}`} href={LINK_HREF}>
          連携して追加
        </a>
      );
    }
    const busy = busyId === item.id;
    return (
      <button type="button" className={`cws-add${compact ? " is-compact" : ""}`} disabled={busyId !== null} onClick={() => setConfirm(item)}>
        {busy ? "処理中…" : item.price <= 0 ? "無料で追加" : `${yen(item.price)} pt で追加`}
      </button>
    );
  };

  return (
    <>
      <Page title={pageTitle} onBack={goBack} wide>
        <div className="cws">
          {notice && (
            <p className={`cws-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
              {notice.text}
            </p>
          )}
          {loadError && <p className="cws-error">{loadError}</p>}

          {route.name === "list" && (
            <>
              <section className="cws-account">
                {linked ? (
                  <>
                    <div className="cws-account-main">
                      <span className="cws-account-label">仙人アカウントの保有ポイント</span>
                      <strong className="cws-account-points">
                        {points === null ? (pointsBusy ? "取得中…" : "—") : yen(points)}
                        {points !== null && <small> pt</small>}
                      </strong>
                      {pointsError && <small className="cws-error-inline">{pointsError}</small>}
                    </div>
                    <div className="cws-account-actions">
                      <button type="button" className="cws-text-btn" onClick={() => void loadPoints()} disabled={pointsBusy}>
                        残高を更新
                      </button>
                      <button type="button" className="cws-text-btn" onClick={() => void unlink()} disabled={unlinking}>
                        {unlinking ? "解除しています…" : "連携を解除"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="cws-account-main">
                      <strong className="cws-account-title">仙人アカウントと連携</strong>
                      <small className="cws-account-text">
                        ポイントで買うには連携が必要です。いま使っているアカウントに連携するので、トークや友だちはそのままです。
                      </small>
                    </div>
                    <a className="cws-primary" href={LINK_HREF}>
                      連携する
                    </a>
                  </>
                )}
              </section>

              <div className="cws-toolbar">
                <label className="cws-search">
                  <Icon name="search" size={18} />
                  <input type="search" placeholder="商品・作者を検索" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="商品を検索" />
                </label>
                <label className="cws-sort">
                  <span>並び替え</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                    {SORTS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <nav className="cws-cats" role="tablist" aria-label="カテゴリ">
                {CATEGORIES.map((c) => (
                  <button key={c.id} type="button" role="tab" aria-selected={category === c.id} className={`cws-cat${category === c.id ? " on" : ""}`} onClick={() => setCategory(c.id)}>
                    {c.label}
                  </button>
                ))}
              </nav>

              {!view ? (
                <p className="cws-empty">読み込み中…</p>
              ) : shown.length === 0 ? (
                <p className="cws-empty">{query ? "一致する商品がありません。" : "このカテゴリの商品はまだありません。"}</p>
              ) : (
                <>
                  <h2 className="cws-heading">
                    {CATEGORIES.find((c) => c.id === category)?.label} <span>{shown.length}件</span>
                  </h2>
                  <ul className="cws-grid">
                    {shown.map((item) => (
                      <li key={item.id} className={`cws-card${item.owned ? " is-owned" : ""}`}>
                        <button type="button" className="cws-card-open" onClick={() => openItem(item)}>
                          <WorkIcon item={item} size={56} />
                          <span className="cws-card-body">
                            <strong className="cws-card-title">{item.name}</strong>
                            <span className="cws-card-desc">{item.description}</span>
                            <span className="cws-rating-line">
                              {item.rating && item.rating.count > 0 ? <Stars value={item.rating.avg} size={12} /> : null}
                              <span>{ratingLabel(item.rating)}</span>
                            </span>
                          </span>
                        </button>
                        <div className="cws-card-meta">
                          {item.source === "studio" && item.creatorId ? (
                            <button type="button" className="cws-author-btn" onClick={() => navigate(storeAuthorPath(item.creatorId!))}>
                              {item.creatorName || "作者"}
                            </button>
                          ) : (
                            <span className="cws-author-plain">仙人ストア</span>
                          )}
                          <span className="cws-kind">{kindLabelOf(item)}</span>
                        </div>
                        <div className="cws-card-foot">
                          {item.price > 0 && !item.owned ? <span className="cws-price">{yen(item.price)} pt</span> : <span />}
                          {renderBuyButton(item, true)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="cws-foot">ポイントは仙人アカウントで管理されます。購入した商品はこのアカウントに残ります。</p>
            </>
          )}

          {route.name === "item" &&
            (!view ? (
              <p className="cws-empty">読み込み中…</p>
            ) : routeItem ? (
              <StoreDetail
                key={routeItem.id}
                item={routeItem}
                me={me}
                linked={linked}
                points={points}
                busyId={busyId}
                buyButton={renderBuyButton(routeItem, false)}
                onUseTheme={(id) => void useTheme(id)}
                onUseAiStyle={(id) => void useAiStyle(id)}
                onReport={(item) => setReportTarget({ id: item.id.slice("work:".length), name: item.name })}
                onOpenAuthor={(creatorId) => navigate(storeAuthorPath(creatorId))}
                onEdit={(workId) => navigate(`/studio/works/${workId}/edit`)}
              />
            ) : (
              <p className="cws-empty">この商品は見つかりませんでした。</p>
            ))}

          {route.name === "author" && (
            <StoreAuthor key={route.id} creatorId={route.id} me={me} onOpenItem={(itemId) => navigate(storeItemPath(itemId))} />
          )}
        </div>
      </Page>

      {reportTarget && (
        <ConfirmDialog
          title="作品を通報しますか？"
          message={`「${reportTarget.name}」を通報します。通報が5件たまると、自動で非公開になります。`}
          confirmLabel="通報する"
          danger
          onConfirm={() => void report(reportTarget)}
          onCancel={() => setReportTarget(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title="購入の確認"
          message={
            confirm.source === "studio" && confirm.creatorId === me.id
              ? `「${confirm.name}」は自分の作品です。${yen(confirm.price)} pt で購入すると、ポイントは作者（自分）ではなく運営に返されます。よろしいですか？`
              : `「${confirm.name}」を ${yen(confirm.price)} pt で購入します。よろしいですか？`
          }
          confirmLabel="購入する"
          busy={busyId !== null}
          onConfirm={() => void buy(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
