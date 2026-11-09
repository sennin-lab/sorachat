import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

// 拡張機能（作者が HTML・CSS・JavaScript で作ったミニアプリ）を動かす画面。
// ソラチャットの画面の中では動かさず、隔離した枠（iframe の sandbox）の中だけで動かす。
// sandbox に allow-same-origin を付けないので、中のコードからソラチャットのログイン情報・画面・通信には触れない。
// （サーバーが返す文書にも CSP の sandbox と通信禁止が付いている）
const SANDBOX = "allow-scripts";

// 買った拡張機能を、全画面で開く
export function ExtensionRunner({ workId, name, onClose }: { workId: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="page ext-run" role="dialog" aria-label={name}>
      <header className="page-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
          <Icon name="back" size={22} />
        </button>
        <h1>{name}</h1>
        <span />
      </header>
      <iframe
        className="ext-frame"
        title={name}
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        src={`/api/studio/extensions/${encodeURIComponent(workId)}/frame`}
      />
      <p className="ext-note">この拡張機能は作者が作ったものです。ソラチャットのアカウント情報には触れない隔離された枠の中で動いています。</p>
    </div>,
    document.body
  );
}

const PREVIEW_FRAME = "ext-preview-frame";

// 公開前の試し表示。書いたコードをサーバーへ送って、本番と同じ隔離の枠で表示する（保存はしない）
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
