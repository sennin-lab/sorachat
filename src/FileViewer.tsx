import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

// トークの中で開けるファイルの種類（サーバーの /file/view と同じ拡張子）
const TEXT_EXTENSIONS = ["txt", "md", "csv", "log", "json"];

export function viewerKindOf(name?: string | null): "pdf" | "text" | null {
  const ext = name?.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.includes(ext)) return "text";
  return null;
}

// PDF とテキストを、トークを離れずに全画面で開く。ダウンロードもここからできる
export function FileViewer({
  url,
  name,
  size,
  onClose,
  onDownload
}: {
  url: string;
  name: string | null;
  size: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  const kind = viewerKindOf(name);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // テキストは中身を読んで表示する（PDF は iframe に直接表示する）
  useEffect(() => {
    if (kind !== "text") return;
    let alive = true;
    fetch(url, { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.text();
      })
      .then((body) => {
        if (alive) setText(body);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [kind, url]);

  return createPortal(
    <div className="file-viewer" role="dialog" aria-modal="true" aria-label={name ?? "ファイル"}>
      <header className="file-viewer-bar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
          <Icon name="back" size={24} />
        </button>
        <span className="file-viewer-title">
          <strong>{name ?? "ファイル"}</strong>
          <small>{size}</small>
        </span>
        <button type="button" className="icon-btn" onClick={onDownload} aria-label="ダウンロード">
          <Icon name="download" size={22} />
        </button>
      </header>

      <div className="file-viewer-body">
        {kind === "pdf" && !failed && <iframe className="file-viewer-frame" src={url} title={name ?? "PDF"} />}
        {kind === "text" && text !== null && <pre className="file-viewer-text">{text}</pre>}
        {kind === "text" && text === null && !failed && <p className="file-viewer-note">読み込んでいます…</p>}
        {(failed || kind === null) && (
          <div className="file-viewer-note">
            <p>このファイルはここでは表示できませんでした。</p>
            <button type="button" className="btn-primary" onClick={onDownload}>
              ダウンロード
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
