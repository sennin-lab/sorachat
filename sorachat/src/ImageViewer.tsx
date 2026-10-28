import { useEffect, useState } from "react";

export function ImageViewer({ src, id, onClose }: { src: string; id: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async () => {
    setBusy(true);
    try {
      const res = await fetch(src, { credentials: "same-origin" });
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `sorachat-${id.slice(0, 8)}.${ext}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      window.open(src, "_blank");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="閉じる">
          <i className="fa-solid fa-xmark" />
        </button>
        <button onClick={download} disabled={busy} aria-label="ダウンロード">
          <i className="fa-solid fa-download" />
        </button>
      </div>
      <img src={src} alt="画像" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
