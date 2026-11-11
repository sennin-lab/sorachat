import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { delete_, post } from "./api";
import { Icon } from "./Icon";

// 拡張機能（作者が HTML・CSS・JavaScript で作ったミニアプリ）を動かす画面。
// ソラチャットの画面の中では動かさず、隔離した枠（iframe の sandbox）の中だけで動かす。
// sandbox に allow-same-origin を付けないので、中のコードからソラチャットのログイン情報・画面・通信には触れない。
// （サーバーが返す文書にも CSP の sandbox と通信禁止が付いている）
//
// 枠の中からポイントを配ったり、アカウント情報を使ったりするのは、window.sorachat（ブリッジ）を通した依頼だけ。
// この画面がその依頼を受けて、利用者の許可を確かめ、サーバーへ取り次ぐ（配布の上限・許可はサーバーが確かめる）。
// 利用者が許可するまでは、枠を開かない。
const SANDBOX = "allow-scripts";
const CHANNEL = "sorachat-ext";

type Access = {
  consented: boolean;
  grant: { remaining: number } | null;
  sorachat?: { id: string; username: string; displayName: string };
  sennin?: { linked: boolean; senninId: string | null };
};

type CallResult = { ok: boolean; body: Record<string, unknown> & { error?: string; code?: string } };

// サーバーの応答を読む（失敗しても、理由を body.error に入れて返す）
async function call(path: string, init?: RequestInit): Promise<CallResult> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined
    });
  } catch {
    return { ok: false, body: { error: "通信に失敗しました。時間をおいてお試しください。", code: "network" } };
  }
  const body = (await res.json().catch(() => ({}))) as CallResult["body"];
  return { ok: res.ok && body.ok !== false, body };
}

type Reply = { ok: boolean; data?: unknown; code?: string; error?: string };

// 拡張機能からの支払いの依頼。確認画面で利用者が決めるまで、依頼の答えは返さない
type PayRequest = {
  amount: number;
  title: string;
  requestId: string;
  resolve: (reply: Reply) => void;
  settled: boolean;
  inFlight: boolean; // サーバーへ払いを頼んでいる最中は、閉じない（払われたかどうかが分からなくなるため）
};

// 買った拡張機能を、全画面で開く
export function ExtensionRunner({ workId, name, onClose }: { workId: string; name: string; onClose: () => void }) {
  const base = `/api/studio/extensions/${encodeURIComponent(workId)}`;
  const [access, setAccess] = useState<Access | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const accessRef = useRef<Access | null>(null);
  const [pay, setPay] = useState<PayRequest | null>(null);
  const payRef = useRef<PayRequest | null>(null);

  // 支払いの答えを、拡張機能に一度だけ返す
  const settlePay = useCallback((reply: Reply) => {
    const current = payRef.current;
    if (!current || current.settled) return;
    current.settled = true;
    current.resolve(reply);
  }, []);

  // 支払いの確認画面を閉じる（答えが返っていなければ、取り消しとして返す）
  const closePay = useCallback(() => {
    settlePay({ ok: false, code: "cancelled", error: "お支払いを取り消しました。" });
    payRef.current = null;
    setPay(null);
  }, [settlePay]);

  // 閉じるとき、確認待ちの支払いを取り消しとして終わらせる（拡張機能を待たせない）
  useEffect(() => () => settlePay({ ok: false, code: "cancelled", error: "お支払いを取り消しました。" }), [settlePay]);

  // 今の許可の状態を、サーバーから読み直す
  const refresh = useCallback(async (): Promise<Access | null> => {
    const result = await call(`${base}/access`);
    if (!result.ok) {
      setLoadError(result.body.error ?? "拡張機能を開けませんでした。");
      return null;
    }
    const next = result.body as unknown as Access;
    accessRef.current = next;
    setAccess(next);
    return next;
  }, [base]);

  // 開いたとき：許可していなければ、まず許可の確認を出す（許可するまで枠は開かない）
  useEffect(() => {
    void (async () => {
      const next = await refresh();
      if (next && !next.consented) setAsking(true);
    })();
  }, [refresh]);

  const finishAsking = () => setAsking(false);

  const allow = async () => {
    setBusy(true);
    setSheetError(null);
    const result = await call(`${base}/consent`, post());
    setBusy(false);
    if (!result.ok) {
      setSheetError(result.body.error ?? "許可できませんでした。もう一度お試しください。");
      return;
    }
    await refresh();
    finishAsking();
  };

  // 断ったら、許可がないまま拡張機能は動かせないので閉じる
  const decline = () => {
    finishAsking();
    if (!accessRef.current?.consented) onClose();
  };

  const revoke = async () => {
    const result = await call(`${base}/consent`, delete_());
    if (!result.ok) {
      setLoadError(result.body.error ?? "取り消せませんでした。もう一度お試しください。");
      return;
    }
    onClose();
  };

  // 枠の中からの依頼を受けて、サーバーへ取り次ぐ。送り元が枠そのものかを確かめてから処理する
  const handle = useCallback(
    async (type: string, data: Record<string, unknown>): Promise<Reply> => {
      if (type === "account") {
        const latest = await refresh();
        if (!latest) return { ok: false, code: "error", error: "アカウント情報を取得できませんでした。" };
        if (!latest.consented) {
          return { ok: false, code: "not_consented", error: "アカウント情報の許可がありません。" };
        }
        return {
          ok: true,
          data: { consented: true, sorachat: latest.sorachat, sennin: latest.sennin, grant: latest.grant }
        };
      }
      if (type === "charge") {
        if (!accessRef.current?.consented) {
          return { ok: false, code: "not_consented", error: "アカウント情報の許可がありません。拡張機能を開き直すと、確認が出ます。" };
        }
        const amount = data.amount;
        const title = typeof data.title === "string" ? data.title.trim() : "";
        const requestId = typeof data.requestId === "string" ? data.requestId : "";
        if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
          return { ok: false, code: "invalid", error: "支払うポイントは 1 以上の整数で指定してください。" };
        }
        if (!title) return { ok: false, code: "invalid", error: "品名を指定してください。" };
        if (payRef.current) {
          return { ok: false, code: "busy", error: "ほかの支払いの確認が出ています。終わってから、もう一度お試しください。" };
        }
        // 確認画面を出し、利用者が決めるまで待つ（支払うと押したときだけ、サーバーで払われる）
        return new Promise<Reply>((resolve) => {
          const request: PayRequest = { amount, title, requestId, resolve, settled: false, inFlight: false };
          payRef.current = request;
          setPay(request);
        });
      }
      if (type === "consent") {
        return accessRef.current?.consented
          ? { ok: true, data: { consented: true } }
          : { ok: false, code: "not_consented", error: "アカウント情報の許可がありません。拡張機能を開き直すと、確認が出ます。" };
      }
      if (type === "award") {
        const result = await call(`${base}/award`, post({ amount: data.amount, reason: data.reason, requestId: data.requestId }));
        if (!result.ok) {
          return {
            ok: false,
            code: result.body.code ?? "error",
            error: result.body.error ?? "ポイントを配れませんでした。",
            data: result.body.remaining !== undefined ? { remaining: result.body.remaining } : undefined
          } as Reply;
        }
        return { ok: true, data: result.body };
      }
      return { ok: false, code: "unknown_request", error: "対応していない依頼です。" };
    },
    [base, refresh]
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return;
      const msg = event.data as { channel?: unknown; id?: unknown; type?: unknown; data?: Record<string, unknown> } | null;
      if (!msg || msg.channel !== CHANNEL || typeof msg.id !== "string" || typeof msg.type !== "string") return;
      const id = msg.id;
      void handle(msg.type, msg.data ?? {}).then((reply) => {
        frame.contentWindow?.postMessage({ channel: CHANNEL, id, ...reply }, "*");
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handle]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (payRef.current) {
        // 支払いの確認が出ているときは、確認画面だけを閉じる（支払いの通信中は閉じない）
        if (!payRef.current.inFlight) closePay();
        return;
      }
      if (asking) {
        setAsking(false);
        if (!accessRef.current?.consented) onClose();
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, onClose, closePay]);

  const consented = Boolean(access?.consented);

  return createPortal(
    <>
      <div className="page ext-run" role="dialog" aria-label={name}>
        <header className="page-head">
          <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
            <Icon name="back" size={22} />
          </button>
          <h1>{name}</h1>
          <span />
        </header>
        {consented ? (
          <iframe
            ref={frameRef}
            className="ext-frame"
            title={name}
            sandbox={SANDBOX}
            referrerPolicy="no-referrer"
            src={`${base}/frame`}
          />
        ) : loadError ? (
          <p className="notice error center">{loadError}</p>
        ) : (
          <div className="ext-wait">{asking ? "アカウント情報の許可を確認してください" : "読み込み中…"}</div>
        )}
        <p className="ext-note">
          この拡張機能は作者が作ったものです。ソラチャットのアカウント情報は、あなたが許可した範囲でだけ渡されます。
          {consented && (
            <>
              {" "}
              <button type="button" className="ext-revoke" onClick={revoke}>
                許可を取り消して閉じる
              </button>
            </>
          )}
        </p>
      </div>
      {pay && (
        <PaySheet
          key={pay.requestId}
          base={base}
          extName={name}
          request={pay}
          onSettle={settlePay}
          onClose={closePay}
        />
      )}
      {asking && (
        <div className="sheet-backdrop ext-consent-backdrop">
          <div className="sheet ext-consent" role="dialog" aria-modal="true" aria-label="アカウント情報の許可">
            <div className="sheet-grip" />
            <strong className="ext-consent-title">アカウント情報の許可</strong>
            <p className="ext-consent-text">「{name}」に、次の情報を渡してもよいですか？</p>
            <ul className="ext-consent-list">
              <li>ソラチャットのアカウント（ユーザー名・表示名・ID）</li>
              <li>仙人アカウントとの連携の有無と、仙人ID</li>
            </ul>
            <p className="ext-consent-text ext-consent-small">
              この拡張機能は、運営が決めた上限の中で、あなたのポイントを配ることがあります。許可は、この画面からいつでも取り消せます。
            </p>
            {sheetError && <p className="notice error center">{sheetError}</p>}
            <div className="confirm-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={decline}>
                キャンセル
              </button>
              <button type="button" className="btn-primary" disabled={busy} onClick={allow}>
                許可する
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}

// ポイントでの支払いの確認画面（ソラチャットの画面の中に出る。拡張機能の枠の中からは、見ても押してもいけない）
// 金額・品名・残高は、この画面が出した値をそのまま使う。支払うを押したときだけ、サーバーへ払いを頼む。
function PaySheet({
  base,
  extName,
  request,
  onSettle,
  onClose
}: {
  base: string;
  extName: string;
  request: PayRequest;
  onSettle: (reply: Reply) => void;
  onClose: () => void;
}) {
  const [balance, setBalance] = useState<number | null>(null);
  const [needsLink, setNeedsLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paidPoints, setPaidPoints] = useState<number | null | undefined>(undefined);

  // 残高を読む（支払う前に、足りるかを見せる）
  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await call("/api/store/balance");
      if (!alive) return;
      if (result.ok && typeof result.body.points === "number") {
        setBalance(result.body.points);
      } else if (result.body.code === "not_linked") {
        setNeedsLink(true);
      } else {
        setError(result.body.error ?? "残高を読めませんでした。");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const pay = async () => {
    setBusy(true);
    setError(null);
    request.inFlight = true;
    const result = await call(`${base}/charge`, post({ amount: request.amount, title: request.title, requestId: request.requestId }));
    request.inFlight = false;
    setBusy(false);
    if (!result.ok) {
      // 同じ requestId で押し直せるので、確認画面は開いたままにする
      setError(result.body.error ?? "支払えませんでした。もう一度お試しください。");
      return;
    }
    const points = typeof result.body.points === "number" ? result.body.points : null;
    setPaidPoints(points);
    if (points !== null) setBalance(points);
    onSettle({ ok: true, data: { charged: request.amount, replayed: Boolean(result.body.replayed), points } });
  };

  const cancel = () => {
    if (busy) return;
    onSettle({ ok: false, code: "cancelled", error: "お支払いを取り消しました。" });
    onClose();
  };

  const shortage = balance !== null && balance < request.amount;
  const paid = paidPoints !== undefined;
  const canPay = !busy && !paid && !needsLink && balance !== null && !shortage;

  return (
    <div className="sheet-backdrop ext-pay-backdrop">
      <div className="ext-pay" role="dialog" aria-modal="true" aria-label="ポイントでの支払い">
        <div className="ext-pay-head">
          <span className="ext-pay-brand">ソラチャット ポイント</span>
          <span className="ext-pay-app">{extName}</span>
        </div>
        <div className="ext-pay-body">
          <p className="ext-pay-title">{request.title}</p>
          <p className="ext-pay-amount">
            <span>{request.amount.toLocaleString("ja-JP")}</span> pt
          </p>
          <dl className="ext-pay-rows">
            <div>
              <dt>いまの残高</dt>
              <dd>{balance === null ? (needsLink ? "—" : "読み込み中…") : `${balance.toLocaleString("ja-JP")} pt`}</dd>
            </div>
            <div>
              <dt>支払い後</dt>
              <dd>
                {balance === null || paid
                  ? paid && paidPoints !== null
                    ? `${paidPoints.toLocaleString("ja-JP")} pt`
                    : "—"
                  : `${(balance - request.amount).toLocaleString("ja-JP")} pt`}
              </dd>
            </div>
          </dl>
          <p className="ext-pay-note">お支払いは、この拡張機能の作者へ全額届きます。</p>
          {needsLink && <p className="notice error center">ポイントで支払うには、仙人アカウントとの連携が必要です。</p>}
          {shortage && !needsLink && <p className="notice error center">ポイントが足りません。</p>}
          {paid && <p className="notice center ext-pay-done">支払いが完了しました。</p>}
          {error && <p className="notice error center">{error}</p>}
        </div>
        <div className="ext-pay-actions">
          {paid ? (
            <button type="button" className="btn-primary" onClick={onClose}>
              閉じる
            </button>
          ) : (
            <>
              <button type="button" className="btn-secondary" disabled={busy} onClick={cancel}>
                キャンセル
              </button>
              <button type="button" className="btn-primary" disabled={!canPay} onClick={pay}>
                {busy ? "支払い中…" : "支払う"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const PREVIEW_FRAME = "ext-preview-frame";

// 公開前の試し表示。書いたコードをサーバーへ送って、本番と同じ隔離の枠で表示する（保存はしない）
// 試し表示では、ブリッジ（ポイント・アカウント情報）は応答しない。確かめるのは、本番で開いたとき。
export function ExtensionPreview({ html, css, js }: { html: string; css: string; js: string }) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => formRef.current?.submit(), 500);
    return () => window.clearTimeout(timer);
  }, [html, css, js]);

  return (
    <div className="ext-preview">
      <form ref={formRef} method="post" action="/api/studio/extensions/preview" target={PREVIEW_FRAME} hidden>
        <textarea name="html" value={html} readOnly />
        <textarea name="css" value={css} readOnly />
        <textarea name="js" value={js} readOnly />
      </form>
      <iframe className="ext-frame ext-frame-preview" name={PREVIEW_FRAME} title="試し表示" sandbox={SANDBOX} referrerPolicy="no-referrer" />
    </div>
  );
}
