import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Page } from "./Page";
import { QrScanner } from "./QrScanner";
import { makeQrImage, merchantIdFromQr, profileQrValue, usernameFromQr } from "./qr";
import type { Friend, Me } from "./types";

// SenninPay（/pay）。仙人アカウントのポイントを、友だちへ送ったり、店舗のQRで払ったりする。
// 画面の作りは PayPay のように、上に残高、その下に「スキャン・送る・受け取る・店舗」の大きなボタン、
// 続けて最近の取引を並べる。QR は友だちのQR（送金）も店舗のQR（支払い）も、同じスキャンで読み取れる。
// 友だちへの送金は、友だちとして登録している人にだけ送れる（サーバーでも確かめている）。

type View = "home" | "scan" | "friends" | "amount" | "receive" | "shop" | "history" | "done";

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

// 送り先（友だち）か、支払い先（店舗）
type Target =
  | { kind: "friend"; id: string; name: string; sub: string; hasAvatar: boolean }
  | { kind: "merchant"; id: string; name: string; sub: string };

type ByUsername = { id: string; username: string; displayName: string; hasAvatar: boolean; isSelf: boolean; isFriend: boolean };

import "./senninpay-motion.css";

const LINK_HREF = "/api/auth/sennin/link?from=pay";
const MAX_AMOUNT = 10_000;
const MAX_DIGITS = String(MAX_AMOUNT).length;

const errorOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。時間をおいてお試しください。");
const pt = (n: number) => `${n.toLocaleString("ja-JP")} pt`;
const whenOf = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const STATUS_TEXT: Record<string, { text: string; tone: "ok" | "ng" | "wait" }> = {
  completed: { text: "完了", tone: "ok" },
  refunded: { text: "返金済み", tone: "ng" },
  failed: { text: "失敗", tone: "ng" },
  pending: { text: "確認中", tone: "wait" },
  debited: { text: "処理中", tone: "wait" }
};

const TITLES: Record<View, string> = {
  home: "SenninPay",
  scan: "スキャン",
  friends: "送る相手を選ぶ",
  amount: "金額を入力",
  receive: "受け取る",
  shop: "店舗",
  history: "取引履歴",
  done: "SenninPay"
};

// 金額（1〜10,000pt の整数）。空や範囲外なら null
function parseAmount(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_AMOUNT ? n : null;
}

export function SenninPayPage({ me, flash, onBack }: { me: Me; flash?: { ok: boolean; text: string } | null; onBack: () => void }) {
  const [view, setView] = useState<View>("home");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(flash ?? null);

  // 送金・支払いの途中の状態
  const [target, setTarget] = useState<Target | null>(null);
  const [amountText, setAmountText] = useState("");
  const [memo, setMemo] = useState("");
  const [clientId, setClientId] = useState(newClientId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PayResult | null>(null);
  // 取引のあとに履歴を取り直すための印
  const [historyKey, setHistoryKey] = useState(0);

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

  const linked = balance?.linked ?? false;
  const amount = parseAmount(amountText);
  const points = balance?.points ?? null;
  const shortage = linked && points !== null && amount !== null && amount > points;

  const startPayment = (next: Target) => {
    setTarget(next);
    setAmountText("");
    setMemo("");
    setResult(null);
    setClientId(newClientId());
    setView("amount");
  };

  const goHome = () => {
    setView("home");
    setTarget(null);
  };

  const pay = async () => {
    if (!target || amount === null) return;
    setBusy(true);
    try {
      const data =
        target.kind === "friend"
          ? await api<PayResult>("/api/pay/friend", post({ toUserId: target.id, amount, memo: memo.trim(), clientId }))
          : await api<PayResult>("/api/pay/qr", post({ merchantId: target.id, amount, memo: memo.trim(), clientId }));
      setResult(
        data.ok ? { ok: true, text: target.kind === "friend" ? `${target.name} さんに送りました。` : `${target.name} に支払いました。` } : data
      );
    } catch (err) {
      setResult({ ok: false, error: errorOf(err) });
    } finally {
      setBusy(false);
      setConfirming(false);
      setView("done");
      setHistoryKey((k) => k + 1);
      loadBalance();
    }
  };

  // 左上の矢印：ホームなら閉じる。金額の入力からは、相手を選ぶ画面に戻る。ほかはホームへ
  const back = () => {
    if (view === "home") onBack();
    else if (view === "amount") setView(target?.kind === "merchant" ? "scan" : "friends");
    else goHome();
  };

  return (
    <Page title={TITLES[view]} onBack={back}>
      {/* 画面が変わるたびに作り直して、入ってくる動きを出す */}
      <div className="pp" key={view}>
        {view === "home" && (
          <HomeView
            notice={notice}
            balance={balance}
            balanceError={balanceError}
            hidden={hidden}
            onToggleHidden={() => setHidden((v) => !v)}
            onRefresh={loadBalance}
            onGo={setView}
            historyKey={historyKey}
          />
        )}

        {view === "scan" && <ScanView linked={linked} onTarget={startPayment} onShowMine={() => setView("receive")} />}

        {view === "friends" && (
          <FriendsView
            linked={linked}
            onPick={(friend) =>
              startPayment({ kind: "friend", id: friend.id, name: friend.displayName, sub: `@${friend.username}`, hasAvatar: friend.hasAvatar })
            }
            onScan={() => setView("scan")}
          />
        )}

        {view === "amount" && target && (
          <AmountView
            target={target}
            amountText={amountText}
            onAmount={setAmountText}
            memo={memo}
            onMemo={setMemo}
            points={points}
            shortage={shortage}
            canPay={linked && amount !== null && !shortage && !busy}
            onSubmit={() => setConfirming(true)}
          />
        )}

        {view === "receive" && <ReceiveView me={me} onScan={() => setView("scan")} />}

        {view === "shop" && <ShopView />}

        {view === "history" && <HistoryList key={historyKey} />}

        {view === "done" && result && target && <DoneView result={result} target={target} amount={amount} onHome={goHome} onRetry={() => setView("amount")} />}
      </div>

      {confirming && target && amount !== null && (
        <ConfirmDialog
          title={target.kind === "friend" ? "送金の確認" : "お支払いの確認"}
          message={
            target.kind === "friend"
              ? `${target.name} さんに ${pt(amount)} を送ります。取り消しはできません。`
              : `${target.name} に ${pt(amount)} を支払います。取り消しはできません。`
          }
          confirmLabel={target.kind === "friend" ? "送る" : "支払う"}
          busy={busy}
          onConfirm={() => void pay()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Page>
  );
}

// ---- ホーム（残高・4つの大きなボタン・最近の取引） ----

function HomeView({
  notice,
  balance,
  balanceError,
  hidden,
  onToggleHidden,
  onRefresh,
  onGo,
  historyKey
}: {
  notice: { ok: boolean; text: string } | null;
  balance: Balance | null;
  balanceError: string;
  hidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
  onGo: (view: View) => void;
  historyKey: number;
}) {
  const linked = balance?.linked ?? false;
  const value = !balance ? "…" : !balance.linked || balance.points === null ? "未連携" : hidden ? "••••" : pt(balance.points);

  return (
    <>
      {notice && (
        <p className={`pp-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
          {notice.text}
        </p>
      )}

      <section className="pp-hero" aria-label="残高">
        <div className="pp-hero-top">
          <span className="pp-hero-label">SenninPay 残高</span>
          <div className="pp-hero-tools">
            <button type="button" className="pp-hero-btn" onClick={onToggleHidden} aria-pressed={hidden}>
              {hidden ? "表示" : "非表示"}
            </button>
            <button type="button" className="pp-hero-btn" onClick={onRefresh} aria-label="残高を更新">
              <Icon name="refresh" size={14} />
            </button>
          </div>
        </div>
        <strong key={value} className="pp-hero-value">{value}</strong>
        <span className="pp-hero-sub">仙人アカウントのポイント</span>
        {balance && !linked && (
          <a className="pp-hero-link" href={LINK_HREF}>
            仙人アカウントと連携する
          </a>
        )}
      </section>
      {balanceError && <p className="pp-error">{balanceError}</p>}

      <nav className="pp-actions" aria-label="SenninPay のメニュー">
        <ActionTile index={0} icon="scan" label="スキャン" onClick={() => onGo("scan")} primary />
        <ActionTile index={1} icon="paysend" label="送る" onClick={() => onGo("friends")} />
        <ActionTile index={2} icon="receive" label="受け取る" onClick={() => onGo("receive")} />
        <ActionTile index={3} icon="shop" label="店舗" onClick={() => onGo("shop")} />
      </nav>

      <section className="pp-section">
        <div className="pp-section-head">
          <h2>最近の取引</h2>
          <button type="button" className="pp-text-btn" onClick={() => onGo("history")}>
            すべて見る
          </button>
        </div>
        <HistoryList key={historyKey} limit={5} />
      </section>
    </>
  );
}

function ActionTile({
  icon,
  label,
  onClick,
  primary = false,
  index = 0
}: {
  icon: string;
  label: string;
  onClick: () => void;
  primary?: boolean;
  index?: number;
}) {
  return (
    <button type="button" className={`pp-tile${primary ? " is-primary" : ""}`} style={{ animationDelay: `${index * 60}ms` }} onClick={onClick}>
      <span className="pp-tile-icon">
        <Icon name={icon} size={26} />
      </span>
      <span className="pp-tile-label">{label}</span>
    </button>
  );
}

// ---- スキャン（友だちのQR・店舗のQRのどちらも読み取れる） ----

function ScanView({ linked, onTarget, onShowMine }: { linked: boolean; onTarget: (target: Target) => void; onShowMine: () => void }) {
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  // 読み取りに失敗したら、カメラを入れ直して続けて読めるようにする
  const [round, setRound] = useState(0);

  const onDetect = async (value: string) => {
    setError("");
    setChecking(true);
    try {
      const merchantId = merchantIdFromQr(value);
      if (merchantId) {
        const data = await api<{ ok: boolean; merchant: MerchantView }>(`/api/pay/merchants/${merchantId}`);
        onTarget({ kind: "merchant", id: data.merchant.id, name: data.merchant.name, sub: data.merchant.description });
        return;
      }
      const username = usernameFromQr(value);
      if (username) {
        const user = await api<ByUsername>(`/api/users/by-username?username=${encodeURIComponent(username)}`);
        if (user.isSelf) throw new Error("自分のQRです。");
        if (!user.isFriend) throw new Error(`${user.displayName} さんとは友だちではありません。友だちになってから送れます。`);
        onTarget({ kind: "friend", id: user.id, name: user.displayName, sub: `@${user.username}`, hasAvatar: user.hasAvatar });
        return;
      }
      throw new Error("SenninPay で使えるQRではありません。");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "通信に失敗しました。時間をおいてお試しください。");
      setRound((r) => r + 1);
    } finally {
      setChecking(false);
    }
  };

  if (!linked) {
    return (
      <div className="pp-empty">
        <p>SenninPay を使うには、仙人アカウントとの連携が必要です。</p>
        <a className="pp-primary pp-link-btn" href={LINK_HREF}>
          仙人アカウントと連携する
        </a>
      </div>
    );
  }

  return (
    <div className="pp-scan">
      <p className="pp-scan-lead">お店のQRか、友だちのQRを読み取ってください</p>
      <div className="pp-scan-box">
        <QrScanner key={round} onDetect={(value) => void onDetect(value)} />
        {checking && <p className="pp-scan-checking">確認しています…</p>}
      </div>
      {error && (
        <p className="pp-error pp-center" role="alert">
          {error}
        </p>
      )}
      <p className="pp-hint pp-center">友だちのQRは、相手の「自分のQR」画面に表示されます。送れるのは友だちだけです。</p>
      <button type="button" className="pp-secondary" onClick={onShowMine}>
        <Icon name="qr" size={18} /> 自分のQRを見せる
      </button>
    </div>
  );
}

// ---- 送る相手を選ぶ（友だち一覧。QRでも選べる） ----

function FriendsView({ linked, onPick, onScan }: { linked: boolean; onPick: (friend: Friend) => void; onScan: () => void }) {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api<Friend[]>("/api/friends")
      .then(setFriends)
      .catch(() => setFriends([]));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!friends) return [];
    return q ? friends.filter((f) => f.displayName.toLowerCase().includes(q) || f.username.toLowerCase().includes(q)) : friends;
  }, [friends, query]);

  return (
    <div className="pp-friends">
      <button type="button" className="pp-qr-row" onClick={onScan} disabled={!linked}>
        <span className="pp-tile-icon is-small">
          <Icon name="scan" size={20} />
        </span>
        <span className="pp-qr-row-text">
          <strong>QRを読み取って送る</strong>
          <small>友だちのQRをスキャンします</small>
        </span>
        <Icon name="chevron" size={18} />
      </button>

      {!linked && <p className="pp-hint">送るには、仙人アカウントとの連携が必要です。</p>}

      <label className="pp-search">
        <Icon name="search" size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="友だちを検索" aria-label="友だちを検索" />
      </label>

      {friends === null ? (
        <p className="pp-hint">読み込み中…</p>
      ) : friends.length === 0 ? (
        <p className="pp-hint">送れる友だちがいません。先に友だちを追加してください。</p>
      ) : shown.length === 0 ? (
        <p className="pp-hint">見つかりませんでした。</p>
      ) : (
        <ul className="pp-list" aria-label="友だち">
          {shown.map((friend) => (
            <li key={friend.id}>
              <button type="button" className="pp-person" disabled={!linked} onClick={() => onPick(friend)}>
                <Avatar userId={friend.id} hasAvatar={friend.hasAvatar} name={friend.displayName} size={44} />
                <span className="pp-person-text">
                  <strong>{friend.displayName}</strong>
                  <small>@{friend.username}</small>
                </span>
                <Icon name="chevron" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="pp-hint">友だちとして登録している人にだけ送れます。相手も仙人アカウントと連携している必要があります。</p>
    </div>
  );
}

// ---- 金額の入力（テンキー） ----

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as const;
type Key = (typeof KEYS)[number];

function AmountView({
  target,
  amountText,
  onAmount,
  memo,
  onMemo,
  points,
  shortage,
  canPay,
  onSubmit
}: {
  target: Target;
  amountText: string;
  onAmount: (value: string) => void;
  memo: string;
  onMemo: (value: string) => void;
  points: number | null;
  shortage: boolean;
  canPay: boolean;
  onSubmit: () => void;
}) {
  const press = (key: Key) => {
    if (key === "⌫") {
      onAmount(amountText.slice(0, -1));
      return;
    }
    // 先頭の 0 は入れない
    if (amountText === "" && (key === "0" || key === "00")) return;
    const next = amountText + key;
    if (next.length > MAX_DIGITS || Number(next) > MAX_AMOUNT) return;
    onAmount(next);
  };

  // 物理キーボードでも入力できるようにする（メッセージの入力中は除く）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (/^[0-9]$/.test(event.key)) press(event.key as Key);
      else if (event.key === "Backspace") press("⌫");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="pp-amount">
      <div className="pp-target">
        {target.kind === "friend" ? (
          <Avatar userId={target.id} hasAvatar={target.hasAvatar} name={target.name} size={52} />
        ) : (
          <span className="pp-shop-badge" aria-hidden="true">
            <Icon name="shop" size={26} />
          </span>
        )}
        <div className="pp-target-text">
          <strong>{target.name}</strong>
          <small>{target.kind === "friend" ? target.sub : target.sub || "店舗へのお支払い"}</small>
        </div>
      </div>

      <div className="pp-amount-display" aria-live="polite">
        <span key={amountText} className="pp-amount-num">{amountText === "" ? "0" : Number(amountText).toLocaleString("ja-JP")}</span>
        <span className="pp-amount-unit">pt</span>
      </div>
      <p className={`pp-amount-sub${shortage ? " is-ng" : ""}`}>
        {shortage
          ? "残高が足りません"
          : points !== null
            ? `残高 ${pt(points)}（1回 1〜${MAX_AMOUNT.toLocaleString("ja-JP")}pt）`
            : `1回 1〜${MAX_AMOUNT.toLocaleString("ja-JP")}pt`}
      </p>

      <label className="pp-memo">
        <input value={memo} maxLength={60} onChange={(e) => onMemo(e.target.value)} placeholder="メッセージを追加（任意・60文字まで）" aria-label="メッセージ" />
      </label>

      <div className="pp-keypad" role="group" aria-label="金額のキーパッド">
        {KEYS.map((key) => (
          <button key={key} type="button" className="pp-key" onClick={() => press(key)} aria-label={key === "⌫" ? "ひとつ消す" : key}>
            {key}
          </button>
        ))}
      </div>

      <button type="button" className="pp-primary pp-submit" disabled={!canPay} onClick={onSubmit}>
        {target.kind === "friend" ? "送る" : "支払う"}
      </button>
    </div>
  );
}

// ---- 受け取る（自分のQR） ----

function ReceiveView({ me, onScan }: { me: Me; onScan: () => void }) {
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    makeQrImage(profileQrValue(me.username))
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [me.username]);

  return (
    <div className="pp-receive">
      <div className="pp-qr-card">
        <div className="pp-qr-who">
          <Avatar userId={me.id} hasAvatar={me.hasAvatar} name={me.displayName} size={48} />
          <div>
            <strong>{me.displayName}</strong>
            <small>@{me.username}</small>
          </div>
        </div>
        {qr ? <img className="pp-qr" src={qr} alt="自分のQR" width={240} height={240} /> : <p className="pp-hint">QRを作成しています…</p>}
        <p className="pp-hint pp-center">友だちにこのQRを読み取ってもらうと、ポイントを送ってもらえます。</p>
      </div>
      <button type="button" className="pp-secondary" onClick={onScan}>
        <Icon name="scan" size={18} /> QRを読み取る
      </button>
      <p className="pp-hint pp-center">ポイントを受け取るには、仙人アカウントとの連携が必要です。送れるのは友だちからだけです。</p>
    </div>
  );
}

// ---- 完了 ----

function DoneView({
  result,
  target,
  amount,
  onHome,
  onRetry
}: {
  result: PayResult;
  target: Target;
  amount: number | null;
  onHome: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="pp-done">
      <span className={`pp-done-icon ${result.ok ? "is-ok" : "is-ng"}`} aria-hidden="true">
        <Icon name={result.ok ? "check" : "close"} size={40} />
      </span>
      <h2>{result.ok ? (target.kind === "friend" ? "送金しました" : "お支払いが完了しました") : "完了できませんでした"}</h2>
      {result.ok ? (
        <>
          {amount !== null && <p className="pp-done-amount">{pt(amount)}</p>}
          <p className="pp-hint pp-center">{result.text}</p>
        </>
      ) : (
        <p className="pp-error pp-center" role="alert">
          {result.error ?? "処理できませんでした。"}
        </p>
      )}
      <div className="pp-done-actions">
        {!result.ok && (
          <button type="button" className="pp-secondary" onClick={onRetry}>
            もう一度
          </button>
        )}
        <button type="button" className="pp-primary" onClick={onHome}>
          閉じる
        </button>
      </div>
    </div>
  );
}

// ---- 店舗（申請・QR） ----

function ShopView() {
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

  if (!state && !error) return <p className="pp-hint">読み込み中…</p>;
  if (!state) return <p className="pp-error">{error}</p>;

  if (!state.linked) {
    return (
      <div className="pp-card">
        <h2 className="pp-h">店舗を申請する</h2>
        <p className="pp-hint">店舗はポイントを受け取るため、仙人アカウントとの連携が必要です。</p>
        <a className="pp-primary pp-link-btn" href={LINK_HREF}>
          仙人アカウントと連携する
        </a>
      </div>
    );
  }

  if (state.merchant) {
    const merchant = state.merchant;
    return (
      <div className="pp-card pp-center">
        <span className="pp-shop-badge is-large" aria-hidden="true">
          <Icon name="shop" size={32} />
        </span>
        <h2 className="pp-h">{merchant.name}</h2>
        {merchant.description && <p className="pp-sub">{merchant.description}</p>}
        <p className={`pp-chip ${merchant.status === "active" ? "is-ok" : "is-ng"}`}>
          {merchant.status === "active" ? "お支払いを受け付け中" : "停止中（運営により一時停止されています）"}
        </p>
        {qr ? <img className="pp-qr" src={qr} alt="店舗のSenninPay QR" width={240} height={240} /> : <p className="pp-hint">QRを作成しています…</p>}
        <p className="pp-hint">お客さんにこのQRを読み取ってもらうと、金額を入れて支払えます。</p>
      </div>
    );
  }

  return (
    <div className="pp-card">
      <h2 className="pp-h">店舗を申請する</h2>
      <p className="pp-hint">申請するとすぐにQRが発行され、SenninPayで支払いを受け取れます。</p>
      <label className="pp-field">
        <span>店舗の名前（40文字まで）</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="pp-field">
        <span>説明（任意・200文字まで）</span>
        <textarea value={description} maxLength={200} rows={3} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <button type="button" className="pp-primary pp-submit" disabled={busy || !name.trim()} onClick={() => void apply()}>
        {busy ? "申請しています…" : "申請してQRを発行する"}
      </button>
      {error && <p className="pp-error">{error}</p>}
    </div>
  );
}

// ---- 取引履歴（ホームでは新しい順に数件、履歴画面では30件） ----

function HistoryList({ limit }: { limit?: number }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api<{ ok: boolean; items: HistoryItem[] }>("/api/pay/history")
      .then((data) => {
        if (alive) setItems(data.items);
      })
      .catch((err) => {
        if (alive) setError(errorOf(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="pp-error">{error}</p>;
  if (!items) return <p className="pp-hint">読み込み中…</p>;
  if (items.length === 0) return <p className="pp-hint">まだ送金・支払いはありません。</p>;

  const rows = limit ? items.slice(0, limit) : items;

  return (
    <ul className="pp-history" aria-label="送金・支払いの履歴">
      {rows.map((item, index) => {
        const status = STATUS_TEXT[item.status] ?? { text: item.status, tone: "wait" as const };
        const sign = item.direction === "in" ? "+" : "−";
        const label =
          item.kind === "qr"
            ? item.direction === "out"
              ? `${item.counterpartName}（店舗）へのお支払い`
              : `${item.counterpartName}（店舗）からの受け取り`
            : item.direction === "out"
              ? `${item.counterpartName} さんに送金`
              : `${item.counterpartName} さんから受け取り`;
        return (
          <li key={item.id} className="pp-history-row" style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}>
            <span className={`pp-history-icon ${item.direction === "in" ? "is-in" : "is-out"}`} aria-hidden="true">
              <Icon name={item.direction === "in" ? "receive" : "paysend"} size={18} />
            </span>
            <div className="pp-history-main">
              <span className="pp-history-label">{label}</span>
              <span className="pp-sub">
                {whenOf(item.createdAt)}
                {item.memo ? ` ・${item.memo}` : ""}
              </span>
              {item.error && <span className="pp-sub pp-ng">{item.error}</span>}
            </div>
            <div className="pp-history-side">
              <strong className={item.direction === "in" ? "pp-in" : "pp-out"}>
                {sign}
                {item.amount.toLocaleString("ja-JP")} pt
              </strong>
              {status.tone !== "ok" && <span className={`pp-status is-${status.tone}`}>{status.text}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
