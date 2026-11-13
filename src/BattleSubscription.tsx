import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { battleApi, newRequestId, type BattleSubscription } from "./battle";
import { errorText } from "./storeUi";

// オンライン対戦のサブスク（1週間 200pt）。仙人ストアの「サブスク」タブと、対戦の前の案内の両方で使う。
// 支払いは、確認を通したあとだけ。通信が途中で切れたときは、同じ申し込み番号で押し直す（二重に払わない）。

const PRICE_TEXT = (sub: BattleSubscription | null) => `${sub?.price ?? 200}pt`;

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// 残高（連携していなければ null）
async function readPoints(): Promise<number | null> {
  try {
    const result = await api<{ points: number }>("/api/store/balance");
    return result.points;
  } catch {
    return null;
  }
}

// 支払いの処理。成功したら新しい状態を返す。失敗したら例外。
// 通信の結果が分からない（503）ときだけ、申し込み番号を残して押し直せるようにする
function useSubscribe(onDone: (next: BattleSubscription) => void) {
  const requestRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy(true);
    setError("");
    requestRef.current ??= newRequestId();
    try {
      const next = await battleApi.subscribe(requestRef.current);
      requestRef.current = null;
      onDone(next);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 503)) requestRef.current = null;
      setError(errorText(e, "申し込めませんでした。もう一度お試しください。"));
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

// 仙人ストアの「サブスク」タブ。状態・期限・自動更新・延長を管理する
export function BattleSubscriptionPanel() {
  const [sub, setSub] = useState<BattleSubscription | null>(null);
  const [loadError, setLoadError] = useState("");
  const [points, setPoints] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState("");

  const load = useCallback(async () => {
    try {
      setSub(await battleApi.subscription());
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e, "サブスクの状態を読めませんでした。"));
    }
    setPoints(await readPoints());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { run, busy, error } = useSubscribe((next) => {
    setSub(next);
    setConfirming(false);
    setNotice(next.subscribed ? `サブスクを更新しました。期限は ${formatDate(next.expiresAt)} までです。` : "");
    void readPoints().then(setPoints);
  });

  const toggleAuto = async () => {
    if (!sub) return;
    setToggleBusy(true);
    setToggleError("");
    try {
      setSub(await battleApi.setAutoRenew(!sub.autoRenew));
    } catch (e) {
      setToggleError(errorText(e, "変更できませんでした。"));
    } finally {
      setToggleBusy(false);
    }
  };

  if (loadError) return <p className="cws-empty">{loadError}</p>;
  if (!sub) return <p className="cws-empty">読み込み中…</p>;

  const active = sub.subscribed;
  const hasHistory = Boolean(sub.expiresAt);

  return (
    <section className="battle-sub" aria-label="オンライン対戦のサブスク">
      <div className="battle-sub-card">
        <p className="battle-sub-kicker">オンライン対戦</p>
        <h2 className="battle-sub-title">サブスク</h2>
        <p className="battle-sub-text">
          拡張機能の「オンライン対戦」（ランダムの対戦・友だちとの対戦）が使えます。料金は1週間 {PRICE_TEXT(sub)} です。
        </p>

        <dl className="battle-sub-rows">
          <div>
            <dt>状態</dt>
            <dd className={active ? "is-on" : ""}>{active ? "有効" : hasHistory ? "期限切れ" : "未加入"}</dd>
          </div>
          <div>
            <dt>期限</dt>
            <dd>{active ? `${formatDate(sub.expiresAt)} まで` : hasHistory ? `${formatDate(sub.expiresAt)} に終了` : "—"}</dd>
          </div>
          <div>
            <dt>いまの残高</dt>
            <dd>{points === null ? (sub.linked ? "読み込み中…" : "—") : `${points.toLocaleString("ja-JP")} pt`}</dd>
          </div>
        </dl>

        {!sub.linked && (
          <p className="notice error">ポイントで支払うには、仙人アカウントとの連携が必要です。仙人ストアの連携から行ってください。</p>
        )}
        {notice && <p className="notice battle-sub-done">{notice}</p>}
        {error && <p className="notice error">{error}</p>}

        <button
          type="button"
          className="btn-primary battle-sub-buy"
          disabled={!sub.linked || busy}
          onClick={() => setConfirming(true)}
        >
          {active ? `1週間延長する（${PRICE_TEXT(sub)}）` : `1週間に入る（${PRICE_TEXT(sub)}）`}
        </button>

        {hasHistory && (
          <label className="battle-sub-auto">
            <input type="checkbox" checked={sub.autoRenew} disabled={toggleBusy} onChange={() => void toggleAuto()} />
            <span>
              <strong>自動更新</strong>
              <small>期限が切れたあとに対戦を始めようとしたとき、1週間分（{PRICE_TEXT(sub)}）を引いて更新します。オフにすると、更新されません。</small>
            </span>
          </label>
        )}
        {toggleError && <p className="notice error">{toggleError}</p>}
      </div>

      <p className="battle-sub-note">
        サブスク料金は、仙人アカウントのポイントから引かれます。
      </p>

      {confirming && (
        <ConfirmDialog
          title="オンライン対戦のサブスク"
          message={
            active
              ? `${PRICE_TEXT(sub)} を支払って、期限を1週間延長します。`
              : `${PRICE_TEXT(sub)} を支払って、1週間オンライン対戦に入ります。`
          }
          confirmLabel="支払う"
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => {
            if (!busy) setConfirming(false);
          }}
        />
      )}
    </section>
  );
}

// 対戦の前に出す案内（拡張機能の中・招待を受けたとき）。入ると、onSubscribed を呼ぶ
export function BattleSubscribeSheet({
  reason,
  onSubscribed,
  onClose
}: {
  reason?: string;
  onSubscribed: () => void;
  onClose: () => void;
}) {
  const [sub, setSub] = useState<BattleSubscription | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const { run, busy, error } = useSubscribe(() => onSubscribed());

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await battleApi.subscription();
        if (alive) setSub(next);
      } catch (e) {
        if (alive) setLoadError(errorText(e, "サブスクの状態を読めませんでした。"));
      }
      const balance = await readPoints();
      if (alive) setPoints(balance);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const canPay = Boolean(sub?.linked) && !busy;

  return (
    <div className="sheet-backdrop confirm-backdrop battle-sub-backdrop">
      <div className="sheet confirm-sheet battle-sub-sheet" role="dialog" aria-modal="true" aria-label="オンライン対戦のサブスク">
        <strong className="confirm-title">オンライン対戦のサブスク</strong>
        <p className="battle-sub-price">
          {sub?.price ?? 200}
          <span> pt / 1週間</span>
        </p>
        <p className="confirm-text">{reason ?? "オンライン対戦は、サブスクに入っている人が使えます。"}</p>
        <dl className="ext-pay-rows">
          <div>
            <dt>いまの残高</dt>
            <dd>{points === null ? "—" : `${points.toLocaleString("ja-JP")} pt`}</dd>
          </div>
          <div>
            <dt>支払い後</dt>
            <dd>{points === null || !sub ? "—" : `${(points - sub.price).toLocaleString("ja-JP")} pt`}</dd>
          </div>
        </dl>
        {loadError && <p className="notice error">{loadError}</p>}
        {sub && !sub.linked && <p className="notice error">ポイントで支払うには、仙人アカウントとの連携が必要です。</p>}
        {points !== null && sub && points < sub.price && sub.linked && <p className="notice error">ポイントが足りません。</p>}
        {error && <p className="notice error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            やめる
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!canPay || (points !== null && sub !== null && points < sub.price)}
            onClick={() => void run()}
          >
            {busy ? "処理中…" : `入る（${sub?.price ?? 200}pt）`}
          </button>
        </div>
      </div>
    </div>
  );
}
