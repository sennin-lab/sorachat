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
      if (asking) {
        setAsking(false);
        if (!accessRef.current?.consented) onClose();
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, onClose]);

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
