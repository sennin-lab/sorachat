import { useCallback, useEffect, useState } from "react";
import { api, post } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Page } from "./Page";
import { BUILTIN_STAMPS, canonicalStampRef } from "./stamps";
import type { Me, StoreItemView, StoreView } from "./types";

// 通報の対象（作品）
type ReportTarget = { id: string; name: string };

type Flash = { ok: boolean; text: string };
type Kind = StoreItemView["kind"];

// 仙人アカウントの連携は、今のソラチャットアカウントに紐づける（ユーザー名・パスワードで作った人も可）
const LINK_HREF = "/api/auth/sennin/link?from=store";

const TABS: { kind: Kind; label: string; text: string }[] = [
  { kind: "theme", label: "外観", text: "トークの吹き出しと背景の色を変えます。自分の画面だけに出ます。" },
  { kind: "stamp_pack", label: "スタンプ", text: "パックを買うと、そのスタンプを送れるようになります。" },
  { kind: "extension", label: "拡張機能", text: "senninai のグループ参加や、ミニゲームを使えるようにします。" }
];

// 外観の見本の色（CSS の data-store-theme と同じ色）
const THEME_PREVIEW: Record<string, { mine: string; bg: string }> = {
  "theme-sakura": { mine: "#ffd6e5", bg: "#fff7fa" },
  "theme-matcha": { mine: "#d4efc9", bg: "#f5fbf2" },
  "theme-sora": { mine: "#cfe9ff", bg: "#f2f8ff" },
  "theme-yuyake": { mine: "#ffd7b8", bg: "#fff8f2" }
};

const yen = (n: number) => `${n.toLocaleString("ja-JP")}`;
const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// 仙人ストア（専用ページ /store）。ポイントで外観・スタンプパック・拡張機能を買う。未連携のときは、まず連携を案内する
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
  const [view, setView] = useState<StoreView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [points, setPoints] = useState<number | null>(null);
  const [pointsBusy, setPointsBusy] = useState(false);
  const [pointsError, setPointsError] = useState("");
  const [kind, setKind] = useState<Kind>("theme");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<StoreItemView | null>(null);
  const [notice, setNotice] = useState<Flash | null>(flash ?? null);
  const [unlinking, setUnlinking] = useState(false);
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);

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

  const items = (view?.items ?? []).filter((item) => item.kind === kind);
  const tab = TABS.find((t) => t.kind === kind) ?? TABS[0];

  return (
    <>
      <Page title="仙人ストア" onBack={onBack}>
        <div className="store-body">
          {linked ? (
            <section className="store-balance">
              <div className="store-balance-main">
                <span className="store-balance-label">保有ポイント（仙人アカウント）</span>
                <strong className="store-balance-points">
                  {points === null ? (pointsBusy ? "取得中…" : "—") : yen(points)}
                  {points !== null && <small> pt</small>}
                </strong>
                {pointsError && <p className="store-error">{pointsError}</p>}
              </div>
              <button type="button" className="store-refresh" onClick={() => void loadPoints()} disabled={pointsBusy}>
                更新
              </button>
            </section>
          ) : (
            <section className="store-link">
              <strong>まず、仙人アカウントと連携しましょう</strong>
              <p>
                ポイントでストアの商品を買うには、仙人アカウントとの連携が必要です。いま使っているソラチャットのアカウントに
                連携するので、トークや友だちはそのままです。
              </p>
              <a className="btn-primary store-link-btn" href={LINK_HREF}>
                仙人アカウントと連携する
              </a>
            </section>
          )}

            {loadError && <p className="store-error">{loadError}</p>}
            {notice && (
              <p className={`store-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
                {notice.text}
              </p>
            )}

            <div className="store-tabs" role="tablist" aria-label="商品の種類">
              {TABS.map((t) => (
                <button
                  key={t.kind}
                  type="button"
                  role="tab"
                  aria-selected={kind === t.kind}
                  className={`store-tab${kind === t.kind ? " on" : ""}`}
                  onClick={() => setKind(t.kind)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="store-tab-text">{tab.text}</p>

            {!view ? (
              <p className="store-empty">読み込み中…</p>
            ) : (
              <ul className="store-list">
                {items.map((item) => {
                  const isBusy = busyId === item.id;
                  const previews: { key: string; src: string; alt: string }[] =
                    item.kind !== "stamp_pack"
                      ? []
                      : item.source === "studio"
                        ? (item.stamps ?? []).slice(0, 8).map((ref) => ({ key: ref, src: ref.replace("studio:", "/api/studio/images/"), alt: "" }))
                        : BUILTIN_STAMPS.filter((s) => (item.stamps ?? []).includes(canonicalStampRef(s.ref))).map((s) => ({ key: s.ref, src: s.url, alt: s.name }));
                  const short = linked && points !== null && !item.owned && points < item.price;
                  return (
                    <li key={item.id} className={`store-card${item.owned ? " is-owned" : ""}`}>
                      <div className="store-card-top">
                        {item.thumbUrl ? (
                          <img className="store-thumb" src={item.thumbUrl} alt="" width={56} height={56} />
                        ) : item.kind === "theme" ? (
                          <span className="store-swatch" aria-hidden="true" style={{ background: THEME_PREVIEW[item.id]?.bg ?? "#fff" }}>
                            <span className="store-swatch-bubble" style={{ background: THEME_PREVIEW[item.id]?.mine }} />
                          </span>
                        ) : (
                          <span className="store-icon" aria-hidden="true">
                            <Icon name={item.kind === "stamp_pack" ? "image" : item.feature?.startsWith("bot") ? "users" : "game"} size={20} />
                          </span>
                        )}
                        <div className="store-card-text">
                          <strong>{item.name}</strong>
                          <small>{item.description}</small>
                          {item.source === "studio" && (
                            <small className="store-creator">
                              作者: {item.creatorName || "—"} ・ {item.studioKind === "quiz" ? "クイズ" : item.studioKind === "ai_style" ? "応答スタイル" : item.studioKind === "theme" ? "外観" : "スタンプ"}
                            </small>
                          )}
                        </div>
                      </div>

                      {previews.length > 0 && (
                        <div className="store-stamps">
                          {previews.map((s) => (
                            <img key={s.key} src={s.src} alt={s.alt} loading="lazy" width={44} height={44} />
                          ))}
                        </div>
                      )}

                      <div className="store-card-foot">
                        <span className={`store-price${item.owned ? " is-owned" : ""}`}>
                          {item.owned ? "購入済み" : `${yen(item.price)} pt`}
                          {short && <small className="store-short"> あと {yen(item.price - (points ?? 0))} pt</small>}
                        </span>

                        {item.kind === "theme" && item.owned ? (
                          item.selected ? (
                            <button
                              type="button"
                              className="btn-small"
                              disabled={busyId !== null}
                              onClick={() => void useTheme(null)}
                            >
                              使用中（標準に戻す）
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn-small accent"
                              disabled={busyId !== null}
                              onClick={() => void useTheme(item.id)}
                            >
                              使う
                            </button>
                          )
                        ) : item.studioKind === "ai_style" && item.owned ? (
                          item.selected ? (
                            <button type="button" className="btn-small" disabled={busyId !== null} onClick={() => void useAiStyle(null)}>
                              使用中（標準に戻す）
                            </button>
                          ) : (
                            <button type="button" className="btn-small accent" disabled={busyId !== null} onClick={() => void useAiStyle(item.id)}>
                              使う
                            </button>
                          )
                        ) : item.owned ? (
                          <span className="store-badge">持っています</span>
                        ) : item.source === "studio" && item.creatorId === me.id ? (
                          <span className="store-badge">あなたの作品</span>
                        ) : linked ? (
                          <button
                            type="button"
                            className="btn-small accent"
                            disabled={busyId !== null || isBusy}
                            onClick={() => setConfirm(item)}
                          >
                            {isBusy ? "処理中…" : "購入する"}
                          </button>
                        ) : (
                          <a className="btn-small accent store-link-inline" href={LINK_HREF}>
                            連携して購入
                          </a>
                        )}
                      </div>
                      {item.source === "studio" && item.creatorId !== me.id && (
                        <button
                          type="button"
                          className="store-report"
                          onClick={() => setReportTarget({ id: item.id.slice("work:".length), name: item.name })}
                        >
                          この作品を通報する
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {linked && (
              <button type="button" className="store-unlink" onClick={() => void unlink()} disabled={unlinking}>
                {unlinking ? "解除しています…" : "仙人アカウントの連携を解除する"}
              </button>
            )}
            <p className="store-foot">
              ポイントは仙人アカウントで管理されます。購入した商品はこのアカウントに残ります。
            </p>
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
          message={`「${confirm.name}」を ${yen(confirm.price)} pt で購入します。よろしいですか？`}
          confirmLabel="購入する"
          busy={busyId !== null}
          onConfirm={() => void buy(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
