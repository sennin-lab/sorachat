import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Icon } from "./Icon";

const SIZE = 280;

export function AvatarCropper({ source, onCancel, onSave }: {
  source: string;
  onCancel: () => void;
  onSave: (blob: Blob) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [dimensions, setDimensions] = useState({ width: SIZE, height: SIZE });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const img = imageRef.current;
    if (!img) return;
    const loaded = () => {
      const scale = SIZE / Math.min(img.naturalWidth, img.naturalHeight);
      setDimensions({ width: img.naturalWidth * scale, height: img.naturalHeight * scale });
      setOffset({ x: 0, y: 0 });
      setZoom(1);
    };
    if (img.complete) loaded();
    else img.addEventListener("load", loaded);
    return () => img.removeEventListener("load", loaded);
  }, [source]);

  const base = SIZE / Math.min(imageRef.current?.naturalWidth || 1, imageRef.current?.naturalHeight || 1);
  const width = dimensions.width * zoom;
  const height = dimensions.height * zoom;
  const left = (SIZE - width) / 2 + offset.x;
  const top = (SIZE - height) / 2 + offset.y;
  const clampOffset = (x: number, y: number, z = zoom) => {
    const w = dimensions.width * z, h = dimensions.height * z;
    return { x: Math.max(SIZE - w - (SIZE-w)/2, Math.min((w-SIZE)/2, x)), y: Math.max(SIZE-h-(SIZE-h)/2, Math.min((h-SIZE)/2, y)) };
  };

  const pointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, dx: offset.x, dy: offset.y };
  };
  const pointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const d = dragRef.current;
    setOffset(clampOffset(d.dx + e.clientX - d.x, d.dy + e.clientY - d.y));
  };
  const pointerUp = () => { dragRef.current = null; };

  const save = () => {
    const img = imageRef.current;
    if (!img || !img.naturalWidth) return;
    setSaving(true);
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) { setSaving(false); return; }
    const scale = base * zoom;
    const sx = Math.max(0, (0 - left) / scale);
    const sy = Math.max(0, (0 - top) / scale);
    const sw = Math.min(SIZE / scale, img.naturalWidth - sx);
    const sh = Math.min(SIZE / scale, img.naturalHeight - sy);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 512, 512);
    canvas.toBlob((blob) => {
      setSaving(false);
      if (blob) onSave(blob);
    }, "image/jpeg", 0.9);
  };

  return (
    <div className="crop-backdrop" role="presentation">
      <section className="crop-dialog" role="dialog" aria-modal="true" aria-label="プロフィール画像を調整">
        <header className="crop-header">
          <button className="icon-btn" onClick={onCancel} aria-label="キャンセル"><Icon name="close" size={21} /></button>
          <strong>画像の表示範囲</strong>
          <span />
        </header>
        <p className="crop-help">画像をドラッグして位置を調整できます。</p>
        <div className="crop-stage" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
          <img ref={imageRef} src={source} alt="" draggable={false} style={{ width, height, left, top }} />
          <div className="crop-circle" />
        </div>
        <label className="crop-zoom">拡大・縮小
          <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(e) => {
            const next = Number(e.target.value);
            setZoom(next);
            setOffset((o) => clampOffset(o.x, o.y, next));
          }} />
        </label>
        <footer className="crop-actions">
          <button className="btn-secondary" onClick={onCancel}>キャンセル</button>
          <button className="btn-primary" disabled={saving} onClick={save}>{saving ? "処理中…" : "この範囲で設定"}</button>
        </footer>
      </section>
    </div>
  );
}
