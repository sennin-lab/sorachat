import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, post } from "./api";
import { ExtensionRunner } from "./ExtensionRunner";
import { Icon } from "./Icon";
import { Page } from "./Page";
import { StoreDetail } from "./StoreDetail";
import { WorkIcon, errorText } from "./storeUi";
import type { Me, StoreDetailView, StoreItemView, StoreView } from "./types";

type Flash = { ok: boolean; text: string };
type Palette = { mine: string; bg: string; accent: string };

// 運営の固定の外観（見本の色）。StoreDetail と同じ値を使う
const FIXED_PALETTE: Record<string, Palette> = {
  "theme-sakura": { mine: "#ffd6e5", bg: "#fff7fa", accent: "#e0789f" },
  "theme-matcha": { mine: "#d4efc9", bg: "#f5fbf2", accent: "#5ea46b" },
  "theme-sora": { mine: "#cfe9ff", bg: "#f2f8ff", accent: "#4f9fe0" },
  "theme-yuyake": { mine: "#ffd7b8", bg: "#fff8f2", accent: "#e8834a" }
};

// 「その他」→「拡張機能」。買った拡張機能を開く・買った外観を選ぶ・標準に戻す、を1つの画面で行う。
// 判定と保存は仙人ストアの API（/api/store・/api/store/theme）をそのまま使う。
export function ExtensionsPage({ me, onBack, onMeChange }: { me: Me; onBack: () => void; onMeChange: (next: Me) => void }) {
  const navigate = useNavigate();
  const [view, setView] = useState<StoreView | null>(null);
  const [loadError, setLoadError] = useState("");
  // 処理中の印（"default" は標準に戻す、それ以外は外観の商品ID）
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Flash | null>(null);
  const [running, setRunning] = useState<{ workId: string; name: string } | null>(null);
  // 作品の外観の配色（一覧には入らないので、詳細から取る）
  const [palettes, setPalettes] = useState<Record<string, Palette | null>>({});
  // 掲載ページ（作品の詳細）を、この画面の中で開く
  const [detailId, setDetailId] = useState<string | null>(null);

  const loadView = useCallback(async () => {
    try {
      setView(await api<StoreView>("/api/store"));
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, "拡張機能を読み込めませんでした。"));
    }
  }, []);

  useEffect(() => {
    void loadView();
  }, [loadView]);

  const items = view?.items ?? [];
  // 買った（または自分の）拡張機能。HTML・CSS・JavaScript で作られた作品は、ここから開く
  const extensions = items.filter((i) => i.studioKind === "extension" && (i.owned || i.creatorId === me.id));
  // 買った機能（グループで使うもの。開くものではないので、説明だけ出す）
  const features = items.filter((i) => i.kind === "extension" && !i.studioKind && i.owned);
  // 買った外観（運営の外観と、作者の作品の外観）
  const themes = items.filter((i) => i.kind === "theme" && i.owned);
  const selected = view?.selectedTheme ?? null;
  const themeKey = themes.map((t) => t.id).join(",");

  // 作品の外観の配色を、詳細から取る（まだ取っていないものだけ）
  useEffect(() => {
    const missing = themes.filter((t) => t.source === "studio" && !(t.id in palettes));
    if (!missing.length) return;
    let alive = true;
    void Promise.all(
      missing.map(async (t) => {
        try {
          const detail = await api<StoreDetailView>(`/api/store/items/${t.id.replace(/^work:/, "")}`);
          // 配色の項目は省けるので、足りない色は標準の色で埋める
          const palette = detail.palette?.mine ? { mine: detail.palette.mine, bg: detail.palette.bg ?? "#fff", accent: detail.palette.accent ?? "#999" } : null;
          return [t.id, palette] as const;
        } catch {
          return [t.id, null] as const;
        }
      })
    ).then((entries) => {
      if (alive) setPalettes((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      alive = false;
    };
    // 外観の一覧が変わったときだけ取り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey]);

  const paletteOf = (item: StoreItemView): Palette | null => (item.source === "studio" ? palettes[item.id] ?? null : FIXED_PALETTE[item.id] ?? null);

  // 外観を選ぶ（null で標準に戻す）。選んだら、配色も含めて自分の情報を取り直して画面に反映する
  const useTheme = async (itemId: string | null) => {
    setBusy(itemId ?? "default");
    setNotice(null);
    try {
      await api<{ storeTheme: string | null }>("/api/store/theme", post({ itemId }));
      onMeChange(await api<Me>("/api/me"));
      await loadView();
      setNotice({ ok: true, text: itemId ? "外観を変えました。" : "外観を標準に戻しました。" });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, "外観を変えられませんでした。") });
    } finally {
      setBusy(null);
    }
  };

  const open = (item: StoreItemView) => setRunning({ workId: item.id.replace(/^work:/, ""), name: item.name });

  if (detailId) {
    // 掲載ページ（概要・レビュー・作者）。ここでも開く・外観を使うができる
    const item = items.find((i) => i.id === detailId) ?? null;
    return (
      <Page wide title={item?.name ?? "拡張機能"} onBack={() => setDetailId(null)}>
        {item ? (
          <StoreDetail
            key={item.id}
            item={item}
            me={me}
            linked={view?.linked ?? false}
            points={null}
            busyId={busy}
            buyButton={null}
            onUseTheme={(id) => void useTheme(id)}
            onUseAiStyle={() => undefined}
            onReport={() => undefined}
            onOpenAuthor={(creatorId) => navigate(`/store/author/${encodeURIComponent(creatorId)}`)}
            onEdit={(workId) => navigate(`/studio/works/${workId}/edit`)}
          />
        ) : (
          <p className="cws-empty">この商品は見つかりませんでした。</p>
        )}
      </Page>
    );
  }

  return (
    <>
      <Page wide title="拡張機能" onBack={onBack}>
        {loadError && (
          <p className="cws-notice is-ng" role="alert">
            {loadError}
          </p>
        )}
        {notice && (
          <p className={`cws-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
            {notice.text}
          </p>
        )}

        <h2 className="cws-heading">
          起動する <span>{extensions.length}件</span>
        </h2>
        {!view ? (
          <p className="cws-empty">読み込み中…</p>
        ) : extensions.length === 0 ? (
          <div className="ext-empty">
            <p className="cws-empty">買った拡張機能はまだありません。</p>
            <button type="button" className="cws-outline cws-small" onClick={() => navigate("/store")}>
              仙人ストアを見る
            </button>
          </div>
        ) : (
          <ul className="ext-list">
            {extensions.map((item) => (
              <li key={item.id} className="ext-row">
                <button type="button" className="ext-row-open" onClick={() => setDetailId(item.id)}>
                  <WorkIcon item={item} size={44} />
                  <span className="ext-row-body">
                    <strong>{item.name}</strong>
                    <small>{item.creatorName ? `作者: ${item.creatorName}` : "拡張機能"}</small>
                  </span>
                </button>
                <button type="button" className="cws-primary cws-primary-sm" onClick={() => open(item)}>
                  <Icon name="play" size={14} /> 開く
                </button>
              </li>
            ))}
          </ul>
        )}

        <h2 className="cws-heading">
          外観 <span>自分の画面だけに出ます</span>
        </h2>
        {!view ? null : (
          <ul className="ext-list">
            <li className={`ext-row${selected === null ? " is-on" : ""}`}>
              <span className="ext-swatch ext-swatch-default" aria-hidden="true">
                <span className="ext-swatch-bubble" />
              </span>
              <span className="ext-row-body">
                <strong>標準（既存の外観）</strong>
                <small>{selected === null ? "いまの見た目で表示しています" : "いつもの見た目に戻せます"}</small>
              </span>
              {selected === null ? (
                <span className="ext-badge">使用中</span>
              ) : (
                <button type="button" className="cws-outline cws-small" disabled={busy !== null} onClick={() => void useTheme(null)}>
                  {busy === "default" ? "変えています…" : "標準に戻す"}
                </button>
              )}
            </li>
            {themes.map((item) => {
              const on = selected === item.id;
              const palette = paletteOf(item);
              return (
                <li key={item.id} className={`ext-row${on ? " is-on" : ""}`}>
                  <span className="ext-swatch" style={{ background: palette?.bg ?? "#fff" }} aria-hidden="true">
                    <span className="ext-swatch-bubble" style={{ background: palette?.mine ?? "#cfe9ff" }} />
                    <span className="ext-swatch-accent" style={{ background: palette?.accent ?? "#999" }} />
                  </span>
                  <span className="ext-row-body">
                    <strong>{item.name}</strong>
                    <small>{item.source === "studio" && item.creatorName ? `作者: ${item.creatorName}` : "仙人ストア"}</small>
                  </span>
                  {on ? (
                    <span className="ext-badge">使用中</span>
                  ) : (
                    <button type="button" className="cws-primary cws-primary-sm" disabled={busy !== null} onClick={() => void useTheme(item.id)}>
                      {busy === item.id ? "変えています…" : "使う"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {view && themes.length === 0 && (
          <p className="cws-empty">買った外観はまだありません。仙人ストアで探せます。</p>
        )}

        {features.length > 0 && (
          <>
            <h2 className="cws-heading">
              使える機能 <span>グループで使います</span>
            </h2>
            <ul className="ext-list">
              {features.map((item) => (
                <li key={item.id} className="ext-row">
                  <span className="ext-row-body">
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </span>
                  <span className="ext-badge">使えます</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="cws-foot">買った商品はこのアカウントに残ります。外観はいつでも選び直せます。</p>
      </Page>
      {running && <ExtensionRunner workId={running.workId} name={running.name} onClose={() => setRunning(null)} />}
    </>
  );
}
