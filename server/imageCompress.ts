import sharp from "sharp";

// 既存画像の一括圧縮で使う。値は src/imageCompress.ts（送信前の圧縮）と揃えている。
// 品質は sharp と同じ 0〜100 の整数で書く。
export type CompressOptions = {
  maxEdge: number; // 長辺の上限（px）
  targetBytes: number; // この大きさに収まるまで品質・解像度を下げる
  minEdge: number; // 長辺の下限（px）
  minQuality: number; // 品質の下限（0〜100）
  startQuality: number; // 最初の品質（0〜100）
};

export const CHAT_IMAGE_OPTIONS: CompressOptions = {
  maxEdge: 1280,
  targetBytes: 300 * 1024,
  minEdge: 720,
  minQuality: 50,
  startQuality: 80
};

export const AVATAR_OPTIONS: CompressOptions = {
  maxEdge: 512,
  targetBytes: 60 * 1024,
  minEdge: 256,
  minQuality: 60,
  startQuality: 80
};

// GIF はアニメーションを保つため対象外
export const COMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * 画像を WebP に圧縮する。圧縮後のほうが小さいときだけ結果を返す。
 * 小さくならない・アニメーションの画像・読めない画像は null を返す（元のまま使う）。
 */
export async function compressStoredImage(input: Buffer, options: CompressOptions): Promise<Buffer | null> {
  try {
    const base = sharp(input, { failOn: "none" }).rotate();
    const meta = await base.metadata();
    if ((meta.pages ?? 1) > 1) return null;

    const rawWidth = meta.width ?? 0;
    const rawHeight = meta.height ?? 0;
    if (!rawWidth || !rawHeight) return null;

    // EXIF の向きで縦横が入れ替わる画像は、入れ替えた後の大きさで計算する
    const swapped = (meta.orientation ?? 1) >= 5;
    const width = swapped ? rawHeight : rawWidth;
    const height = swapped ? rawWidth : rawHeight;
    const longEdge = Math.max(width, height);

    let scale = Math.min(1, options.maxEdge / longEdge);
    const minScale = Math.min(1, options.minEdge / longEdge);
    let result: Buffer | null = null;

    for (;;) {
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const encode = (quality: number) =>
        base.clone().resize(targetWidth, targetHeight, { fit: "fill" }).webp({ quality }).toBuffer();

      let quality = options.startQuality;
      let candidate = await encode(quality);
      while (candidate.length > options.targetBytes && quality > options.minQuality) {
        quality = Math.max(options.minQuality, quality - 10);
        candidate = await encode(quality);
      }

      result = candidate;
      if (candidate.length <= options.targetBytes || scale <= minScale) break;
      scale = Math.max(minScale, scale * 0.8);
    }

    return result && result.length < input.length ? result : null;
  } catch {
    return null;
  }
}
