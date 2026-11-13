import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ApiError, api, post } from "./api";
import { Icon } from "./Icon";
import { Page } from "./Page";
import type { Me } from "./types";
import "./bank.css";

// SenninBank（/bank）。PT を預けると利息がつき、開発者（作者）に投資すると、その人の売上から配当を受け取れる。
// 画面は上に「預かり金額」（利息が毎秒ふえる）、その下に4つのタブ（預金・投資・ランキング・履歴）。
// 金額の入力は、下からせり上がる glass のシート。数字の動きは、フレームごとに文字だけを書き換える（再描画しない）。

type Creator = { id: string; name: string; works: number; investors: number; invested: number; sales: number; myInvested: number };
type Investment = { creatorId: string; name: string; amount: number; dividends: number };
type RankItem = { position: number; name: string; total: number; isMe: boolean };
type HistoryKind = "deposit" | "withdraw" | "invest" | "divest" | "dividend";
type HistoryItem = { id: string; kind: HistoryKind; amount: number; creatorName: string | null; createdAt: string };

type BankState = {
  linked: boolean;
  asOf: string;
  rates: { dailyPercent: number; annualPercent: number; dividendPercent: number };
  limits: { minInvest: number; maxAmount: number };
  deposit: { principal: number; interest: number; perSecond: number; total: number; showName: boolean };
  investedTotal: number;
  dividendTotal: number;
  investments: Investment[];
  creators: Creator[];
  ranking: { items: RankItem[]; me: { position: number; total: number } | null };
  history: HistoryItem[];
};

type Tab = "deposit" | "invest" | "ranking" | "history";
type SheetKind = "deposit" | "withdraw" | "invest" | "divest";
type SheetState = {
  kind: SheetKind;
  title: string;
  hint: string;
  creatorId: string | null;
  min: number;
  max: number;
  // 預け入れ・引き出しを二重に動かさないための操作ID（シートを開くたびに作り直す）
  requestId: string;
};
type FlashMsg = { ok: boolean; text: string } | null;

const TABS: { id: Tab; label: string }[] = [
  { id: "deposit", label: "預金" },
  { id: "invest", label: "投資" },
  { id: "ranking", label: "ランキング" },
  { id: "history", label: "履歴" }
];

const errorOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。時間をおいてお試しください。");
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const fmt = (n: number, digits = 0) => n.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pt = (n: number, digits = 0) => `${fmt(n, digits)} pt`;
const whenOf = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const KIND_TEXT: Record<HistoryKind, { title: (creator: string | null) => string; sign: string; icon: "wallet" | "trend" | "users" | "bank" | "history" }> = {
  deposit: { title: () => "預け入れ", sign: "+", icon: "bank" },
  withdraw: { title: () => "引き出し", sign: "−", icon: "wallet" },
  invest: { title: (c) => `${c ?? "開発者"}に投資`, sign: "", icon: "users" },
  divest: { title: (c) => `${c ?? "開発者"}への投資を戻す`, sign: "", icon: "history" },
  dividend: { title: (c) => `${c ?? "開発者"}からの配当`, sign: "+", icon: "trend" }
};

// 基準の値（base）に、1秒あたりの増加（perSecond）を、受け取った時刻からの経過ぶん足して表示する。
// 再描画はせず、文字だけを書き換えるので、毎フレームでも軽い。
function LiveNumber({ base, perSecond, receivedAt, digits, className }: { base: number; perSecond: number; receivedAt: number; digits: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const loop = () => {
      const elapsed = Math.max(Date.now() - receivedAt, 0) / 1000;
      if (ref.current) ref.current.textContent = fmt(base + perSecond * elapsed, digits);
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [base, perSecond, receivedAt, digits]);
  return <span ref={ref} className={className} />;
}

// 金額を入れるシート（預ける・おろす・投資・投資を戻す の共通）
function AmountSheet({
  sheet,
  balanceLine,
  onClose,
  onSubmit
}: {
  sheet: SheetState;
  balanceLine: string;
  onClose: () => void;
  onSubmit: (amount: number) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const amount = /^\d+$/.test(text) ? Number(text) : 0;
  const valid = amount >= sheet.min && amount <= sheet.max;
  const chips = [100, 500, 1000].filter((value) => value <= sheet.max);

  // 閉じるときは、アニメーションを見せてから外す（動きを減らす設定でも、時間が来れば必ず閉じる）
  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 240);
  }, [closing, onClose]);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const message = await onSubmit(amount);
    setBusy(false);
    if (message) setError(message);
    else close();
  };

  return (
    <div className={`bank-sheet-backdrop${closing ? " is-closing" : ""}`} onClick={close}>
      <div className={`bank-sheet glass${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={sheet.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="bank-sheet-head">
          <strong>{sheet.title}</strong>
          <span>{balanceLine}</span>
        </div>
        <label className={`bank-amount${error ? " is-error" : ""}`}>
          <input
            inputMode="numeric"
            autoFocus
            value={text}
            placeholder="0"
            aria-label="金額"
            onChange={(e) => {
              setText(e.target.value.replace(/\D/g, "").slice(0, 7));
              setError(null);
            }}
          />
          <span>pt</span>
        </label>
        <div className="bank-chips">
          {chips.map((value) => (
            <button key={value} type="button" onClick={() => setText(String(value))}>
              {fmt(value)}
            </button>
          ))}
          <button type="button" disabled={sheet.max < sheet.min} onClick={() => setText(String(sheet.max))}>
            最大
          </button>
        </div>
        <p className="bank-sheet-hint">{sheet.hint}</p>
        {error && <p className="bank-error" role="alert">{error}</p>}
        <button type="button" className="bank-confirm" disabled={!valid || busy} onClick={submit}>
          {busy ? "処理中…" : sheet.title}
        </button>
      </div>
    </div>
  );
}

export function BankPage({ flash, onBack }: { me: Me; flash?: FlashMsg; onBack: () => void }) {
  const [state, setState] = useState<BankState | null>(null);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("deposit");
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [toast, setToast] = useState<FlashMsg>(flash ?? null);
  const [savingName, setSavingName] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<BankState & { ok: boolean }>("/api/bank/state");
      setState(next);
      setReceivedAt(Date.now());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorOf(err));
    }
  }, []);

  // 開いたとき、1分ごとに最新を取り直す（残高は利息で少しずつ変わるため）
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 送信（成功したら残高を取り直す）。失敗したら、シートに出すメッセージを返す
  const perform = async (path: string, body: unknown, done: string): Promise<string | null> => {
    try {
      await api(path, post(body));
      setToast({ ok: true, text: done });
      await load();
      return null;
    } catch (err) {
      return errorOf(err);
    }
  };

  const toggleName = async () => {
    if (!state || savingName) return;
    setSavingName(true);
    try {
      await api("/api/bank/settings", post({ showName: !state.deposit.showName }));
      await load();
    } catch (err) {
      setToast({ ok: false, text: errorOf(err) });
    } finally {
      setSavingName(false);
    }
  };

  const openSheet = (next: Omit<SheetState, "requestId">) => setSheet({ ...next, requestId: newId() });

  if (!state) {
    return (
      <Page title="SenninBank" onBack={onBack}>
        <div className="bank bank-loading">
          <div className="bank-skeleton" />
          <div className="bank-skeleton is-short" />
          {loadError ? <p className="bank-error">{loadError}</p> : <p className="bank-muted">読み込んでいます…</p>}
        </div>
      </Page>
    );
  }

  const { rates, limits, deposit } = state;
  const total = deposit.total + state.investedTotal;
  const balanceNow = deposit.total;
  const tabIndex = TABS.findIndex((t) => t.id === tab);

  const openDeposit = () =>
    openSheet({
      kind: "deposit",
      title: "預ける",
      hint: `ポイントを預金に入れます。利息は毎日つきます（年利 約${fmt(rates.annualPercent, 1)}%・単利）。`,
      creatorId: null,
      min: 1,
      max: limits.maxAmount
    });
  const openWithdraw = () =>
    openSheet({
      kind: "withdraw",
      title: "おろす",
      hint: "預金から、仙人アカウントのポイントに戻します。",
      creatorId: null,
      min: 1,
      max: Math.floor(balanceNow)
    });
  const openInvest = (creator: Creator) =>
    openSheet({
      kind: "invest",
      title: `${creator.name}に投資`,
      hint: `投資した額は預金から移ります。${creator.name}さんの売上の ${fmt(rates.dividendPercent, 0)}% が、投資額の割合で配当になります。`,
      creatorId: creator.id,
      min: limits.minInvest,
      max: Math.min(limits.maxAmount, Math.floor(balanceNow))
    });
  const openDivest = (item: Investment) =>
    openSheet({
      kind: "divest",
      title: "投資を戻す",
      hint: `${item.name}さんへの投資を、預金に戻します。戻した額には、以後は利息がつきます。`,
      creatorId: item.creatorId,
      min: 1,
      max: item.amount
    });

  const submitSheet = (s: SheetState) => async (amount: number) => {
    switch (s.kind) {
      case "deposit":
        return perform("/api/bank/deposit", { requestId: s.requestId, amount }, `${pt(amount)}を預けました`);
      case "withdraw":
        return perform("/api/bank/withdraw", { requestId: s.requestId, amount }, `${pt(amount)}をおろしました`);
      case "invest":
        return perform("/api/bank/invest", { creatorId: s.creatorId, amount }, `${pt(amount)}を投資しました`);
      case "divest":
        return perform("/api/bank/divest", { creatorId: s.creatorId, amount }, `${pt(amount)}の投資を戻しました`);
    }
  };

  const podium = state.ranking.items.slice(0, 3);
  const rest = state.ranking.items.slice(3);
  // 表示の順は 2位・1位・3位（台の形）
  const podiumOrder = [podium[1], podium[0], podium[2]].filter(Boolean) as RankItem[];

  return (
    <Page title="SenninBank" onBack={onBack}>
      <div className="bank">
        <section className="bank-hero glass-strong">
          <div className="bank-hero-glow" aria-hidden />
          <div className="bank-hero-top">
            <span className="bank-badge">
              <Icon name="bank" size={14} /> SenninBank
            </span>
            <span className="bank-badge is-soft">年利 約 {fmt(rates.annualPercent, 1)}%</span>
          </div>
          <p className="bank-hero-label">預かり金額</p>
          <div className="bank-hero-value">
            <LiveNumber base={total} perSecond={deposit.perSecond} receivedAt={receivedAt} digits={2} />
            <small>pt</small>
          </div>
          <div className="bank-hero-split">
            <div>
              <span>預金</span>
              <strong>{pt(deposit.principal)}</strong>
            </div>
            <div>
              <span>利息</span>
              <strong>
                +<LiveNumber base={deposit.interest} perSecond={deposit.perSecond} receivedAt={receivedAt} digits={4} /> pt
              </strong>
            </div>
            <div>
              <span>投資</span>
              <strong>{pt(state.investedTotal)}</strong>
            </div>
          </div>
          <div className="bank-hero-actions">
            <button type="button" className="bank-action is-primary" onClick={openDeposit} disabled={!state.linked}>
              <Icon name="plus" size={20} />
              <span>預ける</span>
            </button>
            <button type="button" className="bank-action" onClick={openWithdraw} disabled={!state.linked || balanceNow < 1}>
              <Icon name="download" size={20} />
              <span>おろす</span>
            </button>
          </div>
          {!state.linked && (
            <p className="bank-link-note">
              ポイントを預けるには、仙人アカウントとの連携が必要です。<a href="/api/auth/sennin/link?from=bank">連携する</a>
            </p>
          )}
        </section>

        <div className="bank-seg" role="tablist" style={{ ["--seg-index" as string]: tabIndex } as CSSProperties}>
          <span className="bank-seg-thumb" aria-hidden />
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* タブが変わるたびに、中身を作り直して出入りの動きを付ける */}
        <div className="bank-panel" key={tab}>
          {tab === "deposit" && (
            <>
              <section className="bank-card glass">
                <div className="bank-row">
                  <span>預金の元本</span>
                  <strong>{pt(deposit.principal)}</strong>
                </div>
                <div className="bank-row">
                  <span>利息（今まで分）</span>
                  <strong>
                    +<LiveNumber base={deposit.interest} perSecond={deposit.perSecond} receivedAt={receivedAt} digits={4} /> pt
                  </strong>
                </div>
                <div className="bank-row">
                  <span>1日あたりの利息</span>
                  <strong>約 {fmt(deposit.perSecond * 86_400, 2)} pt</strong>
                </div>
                <div className="bank-row">
                  <span>受け取った配当（累計）</span>
                  <strong>{pt(state.dividendTotal)}</strong>
                </div>
              </section>
              <section className="bank-note">
                <p>預金には毎日、利息がつきます（単利）。利息は、ポイントを預けた人だけがもらえます。</p>
                <p>投資した分には利息はつきません。代わりに、投資した開発者の売上の一部を配当として受け取れます。</p>
              </section>
            </>
          )}

          {tab === "invest" && (
            <>
              <h2 className="bank-heading">あなたの投資</h2>
              {state.investments.length === 0 ? (
                <p className="bank-empty">まだ投資していません。下の開発者に投資できます。</p>
              ) : (
                <div className="bank-list">
                  {state.investments.map((item, i) => (
                    <article key={item.creatorId} className="bank-card glass bank-stagger" style={{ animationDelay: `${i * 60}ms` }}>
                      <div className="bank-creator">
                        <span className="bank-avatar">{item.name.slice(0, 1)}</span>
                        <div className="bank-creator-text">
                          <strong>{item.name}</strong>
                          <span>投資 {pt(item.amount)} ・ 配当 {pt(item.dividends)}</span>
                        </div>
                      </div>
                      <button type="button" className="bank-ghost" onClick={() => openDivest(item)}>
                        戻す
                      </button>
                    </article>
                  ))}
                </div>
              )}

              <h2 className="bank-heading">投資できる開発者</h2>
              <p className="bank-muted bank-heading-note">
                開発者の売上の {fmt(rates.dividendPercent, 0)}% が、投資家へ配当として配られます。作者の受け取りからその分が引かれ、「senninstudio」の売上で確認できます。
              </p>
              {state.creators.length === 0 ? (
                <p className="bank-empty">いまは投資できる開発者がいません。</p>
              ) : (
                <div className="bank-list">
                  {state.creators.map((c, i) => (
                    <article key={c.id} className="bank-card glass bank-stagger" style={{ animationDelay: `${i * 50}ms` }}>
                      <div className="bank-creator">
                        <span className="bank-avatar is-alt">{c.name.slice(0, 1)}</span>
                        <div className="bank-creator-text">
                          <strong>{c.name}</strong>
                          <span>
                            作品 {c.works} ・ 投資家 {c.investors} 人 ・ 投資の合計 {pt(c.invested)}
                          </span>
                          <span>これまでの売上 {pt(c.sales)}</span>
                        </div>
                      </div>
                      <button type="button" className="bank-action-small" onClick={() => openInvest(c)} disabled={!state.linked || balanceNow < limits.minInvest}>
                        投資する
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === "ranking" && (
            <>
              <p className="bank-muted bank-heading-note">預かり金額（預金・利息・投資の合計）の上位です。</p>
              {podium.length > 0 && (
                <div className="bank-podium">
                  {podiumOrder.map((item) => (
                    <div key={item.position} className={`bank-podium-step is-${item.position}${item.isMe ? " is-me" : ""}`}>
                      <span className="bank-medal">{item.position}</span>
                      <strong>{item.name}</strong>
                      <span>{pt(item.total)}</span>
                      <i aria-hidden />
                    </div>
                  ))}
                </div>
              )}
              {rest.length > 0 && (
                <div className="bank-list bank-ranking-list">
                  {rest.map((item, i) => (
                    <div key={`${item.position}-${i}`} className={`bank-rank-row bank-stagger${item.isMe ? " is-me" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
                      <span className="bank-rank-no">{item.position}</span>
                      <span className="bank-rank-name">{item.name}</span>
                      <strong>{pt(item.total)}</strong>
                    </div>
                  ))}
                </div>
              )}
              {podium.length === 0 && <p className="bank-empty">まだ誰も預けていません。最初の1人になれます。</p>}

              <section className="bank-card glass bank-setting">
                <div>
                  <strong>ランキングに名前を出す</strong>
                  <span>オフにすると「匿名のユーザー」として順位に入ります。</span>
                </div>
                <button type="button" role="switch" aria-checked={deposit.showName} className={`bank-switch${deposit.showName ? " on" : ""}`} onClick={toggleName} disabled={savingName}>
                  <i aria-hidden />
                </button>
              </section>
            </>
          )}

          {tab === "history" && (
            <>
              {state.history.length === 0 ? (
                <p className="bank-empty">まだ取引がありません。</p>
              ) : (
                <div className="bank-list">
                  {state.history.map((item, i) => {
                    const text = KIND_TEXT[item.kind];
                    return (
                      <div key={item.id} className="bank-history-row bank-stagger" style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}>
                        <span className={`bank-history-icon is-${item.kind}`}>
                          <Icon name={text.icon} size={18} />
                        </span>
                        <div className="bank-history-text">
                          <strong>{text.title(item.creatorName)}</strong>
                          <span>{whenOf(item.createdAt)}</span>
                        </div>
                        <strong className="bank-history-amount">
                          {text.sign}
                          {fmt(item.amount, item.amount % 1 === 0 ? 0 : 2)} pt
                        </strong>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {sheet && (
        <AmountSheet
          sheet={sheet}
          balanceLine={`預金 ${pt(balanceNow)}`}
          onClose={() => setSheet(null)}
          onSubmit={submitSheet(sheet)}
        />
      )}

      {toast && (
        <div className={`bank-toast glass-strong${toast.ok ? "" : " is-ng"}`} role="status">
          {toast.text}
        </div>
      )}
    </Page>
  );
}
