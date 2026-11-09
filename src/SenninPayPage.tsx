import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, post } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Page } from "./Page";
import { QrScanner } from "./QrScanner";
import { makeQrImage, merchantIdFromQr } from "./qr";
import type { Friend } from "./types";

// SenninPay（/pay）。仙人アカウントのポイントを、友だちへ送ったり、店舗のQRで払ったりする。
// 店舗の申請をすると、その場でQRが発行される。

type Tab = "send" | "pay" | "shop" | "history";

type Balance = { linked: boolean; points: number | null };
type Merchant = { id: string; name: string; description: string; status: string; createdAt: string; qrValue: string };
type MerchantView = { id: string; name: string; description: string };
type HistoryItem = {
  id: string;
  direction: "in" | "out";
  amount: number;
  memo: string;
  kind: "friend" | "qr";
  status: string;
  createdAt: string;
  counterpartName: string;
  error: string | null;
};
type PayResult = { ok: boolean; error?: string; text?: string };

const TABS: { id: Tab; label: string }[] = [
  { id: "send", label: "送る" },
  { id: "pay", label: "QRで払う" },
  { id: "shop", label: "店舗" },
  { id: "history", label: "履歴" }
];

const LINK_HREF = "/api/auth/sennin/link?from=pay";
const MAX_AMOUNT = 10_000;

const errorOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。時間をおいてお試しください。");
const yenPt = (n: number) => `${n.toLocaleString("ja-JP")} pt`;
const whenOf = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const STATUS_TEXT: Record<string, { text: string; tone: "ok" | "ng" | "wait" }> = {
  completed: { text: "完了", tone: "ok" },
  refunded: { text: "返金済み", tone: "ng" },
  failed: { text: "失敗", tone: "ng" },
  pending: { text: "確認中", tone: "wait" },
  debited: { text: "処理中", tone: "wait" }
};

// 金額の入力（1〜10,000pt の整数）。空や範囲外なら null
function parseAmount(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_AMOUNT ? n : null;
}

export function SenninPayPage({ flash, onBack }: { flash?: { ok: boolean; text: string } | null; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("send");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(flash ?? null);

  const loadBalance = useCallback(() => {
    setBalanceError("");
    api<Balance & { ok: boolean }>("/api/pay/balance")
      .then((data) => setBalance(data))
      .catch((err) => setBalanceError(errorOf(err)));
  }, []);

  useEffect(() => {
    loadBalance();
  }, [loadBalance]);

  useEffect(() => {
    if (flash) setNotice(flash);
  }, [flash]);

  // 支払い・送金のあとに、残高を取り直す
  const afterPayment = () => loadBalance();

  return (
    <Page title="SenninPay" onBack={onBack} wide>
      <div className="pay">
        {notice && (
          <p className={`cws-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
            {notice.text}
          </p>
        )}

        <section className="pay-balance" aria-label="残高">
          <div>
            <span className="pay-balance-label">仙人アカウントの残高</span>
            <strong className="pay-balance-value">
              {balance?.linked && balance.points !== null ? yenPt(balance.points) : balance ? "未連携" : "…"}
            </strong>
          </div>
          <button type="button" className="pay-refresh" onClick={loadBalance} aria-label="残高を更新">
            更新
          </button>
        </section>
        {balanceError && <p className="cws-error">{balanceError}</p>}
        {balance && !balance.linked && (
          <p className="pay-hint">
            SenninPayを使うには、仙人アカウントと連携してください。
            <a className="pay-link" href={LINK_HREF}>
              仙人アカウントと連携する
            </a>
          </p>
        )}

        <div className="pay-tabs" role="tablist">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? "on" : ""}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "send" && <SendTab linked={balance?.linked ?? false} onDone={afterPayment} />}
        {tab === "pay" && <PayTab linked={balance?.linked ?? false} onDone={afterPayment} />}
        {tab === "shop" && <ShopTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </Page>
  );
}

// ---- 友だちへ送る ----

function SendTab({ linked, onDone }: { linked: boolean; onDone: () => void }) {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [toId, setToId] = useState("");
  const [amountText, setAmountText] = useState("");
  const [memo, setMemo] = useState("");
  const [clientId, setClientId] = useState(newClientId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PayResult | null>(null);

  useEffect(() => {
    api<Friend[]>("/api/friends")
      .then(setFriends)
      .catch(() => setFriends([]));
  }, []);

  const amount = parseAmount(amountText);
  const target = friends?.find((f) => f.id === toId) ?? null;
  const canSend = linked && target !== null && amount !== null && !busy;

  const send = async () => {
    if (!target || amount === null) return;
    setBusy(true);
    try {
      const data = await api<PayResult>("/api/pay/friend", post({ toUserId: target.id, amount, memo, clientId }));
      setResult(data.ok ? { ok: true, text: `${target.displayName} さんに ${yenPt(amount)} 送りました。` } : data);
      if (data.ok) {
        setAmountText("");
        setMemo("");
        setClientId(newClientId());
      }
    } catch (err) {
      setResult({ ok: false, error: errorOf(err) });
    } finally {
      setBusy(false);
      setConfirming(false);
      onDone();
    }
  };

  return (
    <section className="pay-card">
      <h2 className="pay-h">友だちに送る</h2>
      <p className="pay-hint">友だちとして登録している人にだけ送れます。相手も仙人アカウントと連携している必要があります。</p>

      {friends === null ? (
        <p className="pay-hint">読み込み中…</p>
      ) : friends.length === 0 ? (
        <p className="pay-hint">送れる友だちがいません。先に友だちを追加してください。</p>
      ) : (
        <ul className="pay-list" aria-label="友だち">
          {friends.map((friend) => (
            <li key={friend.id}>
              <label className="pay-choice">
                <input type="radio" name="pay-friend" checked={toId === friend.id} onChange={() => setToId(friend.id)} />
                <span>{friend.displayName}</span>
                <span className="pay-sub">@{friend.username}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <label className="pay-field">
        <span>金額（1〜{MAX_AMOUNT.toLocaleString("ja-JP")} pt）</span>
        <input inputMode="numeric" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="100" />
      </label>
      <label className="pay-field">
        <span>メモ（任意・60文字まで）</span>
        <input value={memo} maxLength={60} onChange={(e) => setMemo(e.target.value)} />
      </label>

      <button type="button" className="cws-primary pay-submit" disabled={!canSend} onClick={() => setConfirming(true)}>
        送る
      </button>

      <PayResultNote result={result} />

      {confirming && target && amount !== null && (
        <ConfirmDialog
          title="送金の確認"
          message={`${target.displayName} さんに ${yenPt(amount)} を送ります。取り消しはできません。`}
          confirmLabel="送る"
          busy={busy}
          onConfirm={() => void send()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

// ---- QRで払う ----

function PayTab({ linked, onDone }: { linked: boolean; onDone: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [merchant, setMerchant] = useState<MerchantView | null>(null);
  const [amountText, setAmountText] = useState("");
  const [memo, setMemo] = useState("");
  const [clientId, setClientId] = useState(newClientId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PayResult | null>(null);

  const onDetect = async (value: string) => {
    setScanning(false);
    setScanError("");
    setResult(null);
    const id = merchantIdFromQr(value);
    if (!id) {
      setScanError("SenninPayの店舗QRではありません。");
      return;
    }
    try {
      const data = await api<{ ok: boolean; merchant: MerchantView }>(`/api/pay/merchants/${id}`);
      setMerchant(data.merchant);
      setClientId(newClientId());
    } catch (err) {
      setScanError(errorOf(err));
    }
  };

  const amount = parseAmount(amountText);
  const canPay = linked && merchant !== null && amount !== null && !busy;

  const pay = async () => {
    if (!merchant || amount === null) return;
    setBusy(true);
    try {
      const data = await api<PayResult>("/api/pay/qr", post({ merchantId: merchant.id, amount, memo, clientId }));
      setResult(data.ok ? { ok: true, text: `${merchant.name} に ${yenPt(amount)} を支払いました。` } : data);
      if (data.ok) {
        setMerchant(null);
        setAmountText("");
        setMemo("");
      }
    } catch (err) {
      setResult({ ok: false, error: errorOf(err) });
    } finally {
      setBusy(false);
      setConfirming(false);
      onDone();
    }
  };

  return (
    <section className="pay-card">
      <h2 className="pay-h">QRで払う</h2>
      <p className="pay-hint">お店のSenninPay QRを読み取り、金額を入れて支払います。</p>

      {!merchant && (
        <>
          {scanning ? (
            <div className="pay-scan">
              <QrScanner onDetect={(value) => void onDetect(value)} />
              <button type="button" className="btn-secondary" onClick={() => setScanning(false)}>
                やめる
              </button>
            </div>
          ) : (
            <button type="button" className="cws-primary pay-submit" disabled={!linked} onClick={() => setScanning(true)}>
              QRを読み取る
            </button>
          )}
          {scanError && <p className="cws-error">{scanError}</p>}
        </>
      )}

      {merchant && (
        <div className="pay-merchant">
          <strong className="pay-merchant-name">{merchant.name}</strong>
          {merchant.description && <p className="pay-sub">{merchant.description}</p>}
          <label className="pay-field">
            <span>金額（1〜{MAX_AMOUNT.toLocaleString("ja-JP")} pt）</span>
            <input inputMode="numeric" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="500" autoFocus />
          </label>
          <label className="pay-field">
            <span>メモ（任意）</span>
            <input value={memo} maxLength={60} onChange={(e) => setMemo(e.target.value)} />
          </label>
          <div className="pay-actions">
            <button type="button" className="btn-secondary" onClick={() => setMerchant(null)} disabled={busy}>
              やめる
            </button>
            <button type="button" className="cws-primary" disabled={!canPay} onClick={() => setConfirming(true)}>
              支払う
            </button>
          </div>
        </div>
      )}

      <PayResultNote result={result} />

      {confirming && merchant && amount !== null && (
        <ConfirmDialog
          title="お支払いの確認"
          message={`${merchant.name} に ${yenPt(amount)} を支払います。取り消しはできません。`}
          confirmLabel="支払う"
          busy={busy}
          onConfirm={() => void pay()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

// ---- 店舗（申請・QR） ----

function ShopTab() {
  const [state, setState] = useState<{ linked: boolean; merchant: Merchant | null } | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    api<{ ok: boolean; linked: boolean; merchant: Merchant | null }>("/api/pay/merchant")
      .then((data) => setState({ linked: data.linked, merchant: data.merchant }))
      .catch((err) => setError(errorOf(err)));
  }, []);

  const qrValue = state?.merchant?.qrValue ?? null;
  useEffect(() => {
    if (!qrValue) return;
    let alive = true;
    makeQrImage(qrValue)
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [qrValue]);

  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await api<{ ok: boolean; merchant: Merchant }>("/api/pay/merchant", post({ name: name.trim(), description: description.trim() }));
      setState((prev) => ({ linked: prev?.linked ?? true, merchant: data.merchant }));
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (!state && !error) return <p className="pay-hint">読み込み中…</p>;
  if (!state) return <p className="cws-error">{error}</p>;

  if (!state.linked) {
    return (
      <section className="pay-card">
        <h2 className="pay-h">店舗を申請する</h2>
        <p className="pay-hint">店舗はポイントを受け取るため、仙人アカウントとの連携が必要です。</p>
        <a className="cws-primary pay-submit pay-link-button" href={LINK_HREF}>
          仙人アカウントと連携する
        </a>
      </section>
    );
  }

  if (state.merchant) {
    const merchant = state.merchant;
    return (
      <section className="pay-card pay-shop">
        <h2 className="pay-h">{merchant.name}</h2>
        {merchant.description && <p className="pay-sub">{merchant.description}</p>}
        <p className="pay-hint">
          状態：{merchant.status === "active" ? "お支払いを受け付け中" : "停止中（運営により一時停止されています）"}
        </p>
        {qr ? <img className="pay-qr" src={qr} alt="店舗のSenninPay QR" width={240} height={240} /> : <p className="pay-hint">QRを作成しています…</p>}
        <p className="pay-hint">お客さんにこのQRを読み取ってもらうと、金額を入れて支払えます。</p>
      </section>
    );
  }

  return (
    <section className="pay-card">
      <h2 className="pay-h">店舗を申請する</h2>
      <p className="pay-hint">申請するとすぐにQRが発行され、SenninPayで支払いを受け取れます。</p>
      <label className="pay-field">
        <span>店舗の名前（40文字まで）</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="pay-field">
        <span>説明（任意・200文字まで）</span>
        <textarea value={description} maxLength={200} rows={3} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <button type="button" className="cws-primary pay-submit" disabled={busy || !name.trim()} onClick={() => void apply()}>
        {busy ? "申請しています…" : "申請してQRを発行する"}
      </button>
      {error && <p className="cws-error">{error}</p>}
    </section>
  );
}

// ---- 履歴 ----

function HistoryTab() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    api<{ ok: boolean; items: HistoryItem[] }>("/api/pay/history")
      .then((data) => setItems(data.items))
      .catch((err) => setError(errorOf(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="cws-error">{error}</p>;
  if (!items) return <p className="pay-hint">読み込み中…</p>;
  if (items.length === 0) return <p className="pay-hint">まだ送金・支払いはありません。</p>;

  return (
    <section className="pay-card">
      <div className="pay-actions pay-actions-end">
        <button type="button" className="pay-refresh" onClick={load}>
          更新
        </button>
      </div>
      <ul className="pay-history" aria-label="送金・支払いの履歴">
        {items.map((item) => {
          const status = STATUS_TEXT[item.status] ?? { text: item.status, tone: "wait" as const };
          const sign = item.direction === "in" ? "+" : "−";
          const label: ReactNode =
            item.kind === "qr"
              ? item.direction === "out"
                ? `${item.counterpartName}（店舗）へのお支払い`
                : `${item.counterpartName}（店舗）からの受け取り`
              : item.direction === "out"
                ? `${item.counterpartName} さんに送金`
                : `${item.counterpartName} さんから受け取り`;
          return (
            <li key={item.id} className="pay-history-row">
              <div>
                <span className="pay-history-label">{label}</span>
                {item.memo && <span className="pay-sub"> ・{item.memo}</span>}
                <div className="pay-sub">{whenOf(item.createdAt)}</div>
                {item.error && <div className="pay-sub pay-ng">{item.error}</div>}
              </div>
              <div className="pay-history-side">
                <strong className={item.direction === "in" ? "pay-in" : "pay-out"}>
                  {sign}
                  {item.amount.toLocaleString("ja-JP")} pt
                </strong>
                <span className={`pay-status is-${status.tone}`}>{status.text}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PayResultNote({ result }: { result: PayResult | null }) {
  if (!result) return null;
  if (result.ok) return <p className="cws-notice is-ok" role="status">{result.text ?? "完了しました。"}</p>;
  return (
    <p className="cws-notice is-ng" role="alert">
      {result.error ?? "処理できませんでした。"}
    </p>
  );
}
