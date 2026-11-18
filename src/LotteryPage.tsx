import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, post } from "./api";
import { Page } from "./Page";
import "./lottery.css";

// 宝くじ（/lottery）。1券 1000pt。結果発表日になると、管理者が発表する。
// 当選番号は一桁ずつ公開され（ゆっくり、左から）、全部見せ終わると結果が確定して、当選者が出る。

type Prize = { tier: number; pt: number };
type Winner = { tier: number; number: string; prize: number; name: string; userId: string };
type LotteryView = {
  id: string;
  name: string;
  ticketPrice: number;
  digits: number;
  prizes: Prize[];
  announceOn: string;
  status: "selling" | "revealing" | "done";
  revealed: string;
  winningNumber: string | null;
  winners: Winner[] | null;
  sold: number;
  myTickets: string[];
  myWinCount: number;
};
type StateResponse = { ok: true; ticketPrice: number; maxPerRequest: number; maxPerUser: number; lotteries: LotteryView[] };

const errorOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。時間をおいてお試しください。");
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const fmt = (n: number) => n.toLocaleString("ja-JP");
const STATUS_TEXT: Record<LotteryView["status"], string> = { selling: "販売中", revealing: "発表中", done: "結果確定" };

// 当たりの等（画面で自分の券を照らし合わせるため。判定はサーバーと同じ：末尾の桁数が一致すれば、その等）
function tierOfTicket(ticket: string, winning: string, tierCount: number): number | null {
  const digits = winning.length;
  for (let tier = 1; tier <= tierCount; tier++) {
    const k = digits + 1 - tier;
    if (k <= 0) break;
    if (ticket.slice(-k) === winning.slice(-k)) return tier;
  }
  return null;
}

// 当選番号の桁。公開済みの桁は本当の数字、まだの桁は回る数字（飾り。本当の数字は含まない）
function NumberBoard({ digits, revealed, mode }: { digits: number; revealed: string; mode: "hidden" | "spin" | "final" }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mode !== "spin") return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 80);
    return () => window.clearInterval(timer);
  }, [mode]);

  return (
    <div className="lot-digits" aria-label={mode === "hidden" ? "当選番号は発表まで伏せられています" : `当選番号 ${revealed}`}>
      {Array.from({ length: digits }, (_, i) => {
        const isRevealed = mode === "final" || i < revealed.length;
        if (mode === "hidden") {
          return <span key={`h${i}`} className="lot-digit">?</span>;
        }
        if (isRevealed) {
          // 公開された桁は、ぽんと出す（桁が増えるたびに新しい要素になるので、そのたびに動く）
          return <span key={`r${i}-${revealed[i] ?? ""}`} className="lot-digit is-revealed">{revealed[i]}</span>;
        }
        return <span key={`s${i}`} className="lot-digit is-spin">{(tick + i * 3) % 10}</span>;
      })}
    </div>
  );
}

function LotteryCard({
  lottery,
  maxPerRequest,
  maxPerUser,
  onChanged
}: {
  lottery: LotteryView;
  maxPerRequest: number;
  maxPerUser: number;
  onChanged: () => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // 購入の操作ID。通信が切れたときに同じIDで押し直すと、二重に買わない（失敗が確定したら作り直す）
  const requestRef = useRef<{ key: string; id: string } | null>(null);

  const owned = lottery.myTickets.length;
  const remaining = Math.max(maxPerUser - owned, 0);
  const maxBuy = Math.min(maxPerRequest, remaining);
  const shownQuantity = Math.min(quantity, Math.max(maxBuy, 1));
  const cost = shownQuantity * lottery.ticketPrice;
  const tierCount = lottery.prizes.length;
  const mode = lottery.status === "selling" ? "hidden" : lottery.status === "revealing" ? "spin" : "final";

  const buy = async () => {
    const key = `${lottery.id}:${shownQuantity}`;
    if (!requestRef.current || requestRef.current.key !== key) requestRef.current = { key, id: newId() };
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/lottery/${lottery.id}/buy`, post({ requestId: requestRef.current.id, quantity: shownQuantity }));
      requestRef.current = null;
      setMessage({ ok: true, text: `${shownQuantity}枚買いました。` });
      await onChanged();
    } catch (err) {
      // 「確かめられない」失敗（通信など）のときは、同じIDのまま残す。はっきり失敗したものは作り直す
      if (err instanceof ApiError && err.status < 500) requestRef.current = null;
      setMessage({ ok: false, text: errorOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="lot-card" aria-label={lottery.name}>
      <div className="lot-head">
        <h2 className="lot-title">{lottery.name}</h2>
        <span className={`lot-status is-${lottery.status}`}>{STATUS_TEXT[lottery.status]}</span>
      </div>
      <p className="lot-meta">
        1券 {fmt(lottery.ticketPrice)}pt ・ {lottery.digits}桁 ・ 結果発表日 {lottery.announceOn} ・ 販売 {fmt(lottery.sold)}枚
      </p>

      <ul className="lot-prizes">
        {lottery.prizes.map((p) => (
          <li key={p.tier}>
            <span>{p.tier}等</span>
            <span>{fmt(p.pt)}pt</span>
          </li>
        ))}
      </ul>

      <NumberBoard digits={lottery.digits} revealed={lottery.revealed} mode={mode} />
      {lottery.status === "selling" && <p className="lot-note">当選番号は、結果発表日に発表されます。</p>}
      {lottery.status === "revealing" && <p className="lot-note">番号を一桁ずつ公開中です…</p>}

      {lottery.status === "selling" && (
        <div className="lot-buy">
          {remaining > 0 ? (
            <>
              <div className="lot-stepper" role="group" aria-label="枚数">
                <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={busy || shownQuantity <= 1} aria-label="1枚減らす">−</button>
                <span className="lot-qty" aria-live="polite">{shownQuantity}枚</span>
                <button type="button" onClick={() => setQuantity((q) => Math.min(maxBuy, q + 1))} disabled={busy || shownQuantity >= maxBuy} aria-label="1枚増やす">＋</button>
              </div>
              <button type="button" className="btn-primary lot-buy-btn" onClick={() => void buy()} disabled={busy}>
                {busy ? "購入中…" : `${fmt(cost)}pt で買う`}
              </button>
            </>
          ) : (
            <p className="lot-note">この宝くじは、1人{maxPerUser}枚までです。</p>
          )}
          {message && <p className={`lot-msg ${message.ok ? "is-ok" : "is-err"}`}>{message.text}</p>}
        </div>
      )}

      {owned > 0 && (
        <div className="lot-section">
          <h3>あなたの券（{fmt(owned)}枚）</h3>
          <div className="lot-chips">
            {lottery.myTickets.map((t, i) => {
              const tier = lottery.status === "done" && lottery.winningNumber ? tierOfTicket(t, lottery.winningNumber, tierCount) : null;
              return (
                <span key={`${t}-${i}`} className={`lot-chip${tier !== null ? " is-win" : ""}`}>
                  {t}{tier !== null ? `　${tier}等` : ""}
                </span>
              );
            })}
          </div>
          {lottery.status === "done" && (
            <p className="lot-note">{lottery.myWinCount > 0 ? `当選しました！ ${lottery.myWinCount}枚が当たりです。賞金は仙人アカウントのポイントに入ります。` : "残念ながら、今回は当たりませんでした。"}</p>
          )}
        </div>
      )}

      {lottery.status === "done" && lottery.winners && (
        <div className="lot-section">
          <h3>当選者</h3>
          {lottery.winners.length === 0 ? (
            <p className="lot-note">当選者はいませんでした。</p>
          ) : (
            <ul className="lot-winners">
              {lottery.winners.map((w, i) => (
                <li key={`${w.userId}-${w.number}-${i}`}>
                  <span className="lot-win-tier">{w.tier}等</span>
                  <span className="lot-win-number">{w.number}</span>
                  <span className="lot-win-name">{w.name}</span>
                  <span className="lot-win-pt">{fmt(w.prize)}pt</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export function LotteryPage({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<StateResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<StateResponse>("/api/lottery/state"));
      setError("");
    } catch (err) {
      setError(errorOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 発表中は、番号が一桁ずつ増えるように読み直す
  const revealing = data?.lotteries.some((l) => l.status === "revealing") ?? false;
  useEffect(() => {
    if (!revealing) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [revealing, load]);

  return (
    <Page title="宝くじ" onBack={onBack}>
      <div className="lot-wrap">
        {!data && <p className="lot-note">{error || "読み込み中…"}</p>}
        {data && data.lotteries.length === 0 && <p className="lot-note">いま販売中の宝くじはありません。</p>}
        {data?.lotteries.map((l) => (
          <LotteryCard key={l.id} lottery={l} maxPerRequest={data.maxPerRequest} maxPerUser={data.maxPerUser} onChanged={load} />
        ))}
        {data && error && <p className="lot-msg is-err">{error}</p>}
      </div>
    </Page>
  );
}
