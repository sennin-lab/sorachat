// 送信前に画像を端末の中で縮小・再圧縮する（転送量とサーバーの保存量を減らすため）。
// 長辺を maxEdge 以下に縮め、目標サイズに収まるまで品質を下げ、それでも大きければ解像度を段階的に下げる。
// 圧縮後のほうが小さいときだけ圧縮版を使い、そうでなければ元のファイルをそのまま送る。
// 失敗（デコードできない形式など）のときも元のファイルを送るので、今までの動作は変わらない。

export type CompressOptions = {
  maxEdge: number; // 長辺の上限（px）。これより小さい画像は拡大しない
  targetBytes: number; // この大きさに収まるまで品質・解像度を下げる
  minEdge: number; // 長辺の下限（px）。これより小さくはしない
  minQuality: number; // 品質の下限（0〜1）
  startQuality: number; // 最初の品質（0〜1）
};

// トークの写真：画面で十分見える大きさに抑える
export const CHAT_IMAGE_OPTIONS: CompressOptions = {
  maxEdge: 1280,
  targetBytes: 300 * 1024,
  minEdge: 720,
  minQuality: 0.5,
  startQuality: 0.8
};

// アイコン（プロフィール・グループ・管理者）：表示サイズは小さいので強めに圧縮する
export const AVATAR_OPTIONS: CompressOptions = {
  maxEdge: 512,
  targetBytes: 60 * 1024,
  minEdge: 256,
  minQuality: 0.6,
  startQuality: 0.8
};

// アニメーションを保つため、GIF は圧縮せずそのまま送る
const PASSTHROUGH_TYPES = new Set(["image/gif"]);

type Decoded = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // 下の <img> での読み込みに切り替える
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("画像を読み込めませんでした。"));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

// このブラウザが WebP を書き出せるか（Safari の古い版などは PNG に戻るため、確かめて決める）
let webpSupport: Promise<boolean> | null = null;
function canEncodeWebp(): Promise<boolean> {
  if (!webpSupport) {
    webpSupport = (async () => {
      const probe = document.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      const blob = await encode(probe, "image/webp", 0.8);
      return blob?.type === "image/webp";
    })();
  }
  return webpSupport;
}

function renamed(name: string, extension: string) {
  const stem = name.replace(/\.[^.]+$/, "") || "image";
  return `${stem}.${extension}`;
}

/**
 * 画像を送信用に圧縮する。画像でないもの・GIF・読み込めないものは、元のまま返す。
 * 戻り値は File（名前は元のファイル名の拡張子を付け替えたもの）。
 */
export async function compressImage(input: File | Blob, options: CompressOptions): Promise<File> {
  const name = input instanceof File ? input.name : "image";
  const original = input instanceof File ? input : new File([input], name, { type: input.type });
  if (!input.type.startsWith("image/") || PASSTHROUGH_TYPES.has(input.type)) return original;

  let decoded: Decoded;
  try {
    decoded = await decode(input);
  } catch {
    return original;
  }

  try {
    if (!decoded.width || !decoded.height) return original;

    const webp = await canEncodeWebp();
    const type = webp ? "image/webp" : "image/jpeg";
    const longEdge = Math.max(decoded.width, decoded.height);
    let scale = Math.min(1, options.maxEdge / longEdge);
    const minScale = Math.min(1, options.minEdge / longEdge);

    let result: Blob | null = null;
    for (;;) {
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return original;
      // JPEG は透過できないので白で塗る（WebP は透過をそのまま残す）
      if (!webp) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.source, 0, 0, width, height);

      let quality = options.startQuality;
      let candidate = await encode(canvas, type, quality);
      while (candidate && candidate.size > options.targetBytes && quality > options.minQuality) {
        quality = Math.max(options.minQuality, quality - 0.1);
        candidate = await encode(canvas, type, quality);
      }
      if (!candidate) return original;

      result = candidate;
      if (candidate.size <= options.targetBytes || scale <= minScale) break;
      scale = Math.max(minScale, scale * 0.8);
    }

    if (!result || result.size >= original.size) return original;
    const extension = webp ? "webp" : "jpg";
    return new File([result], renamed(name, extension), { type: result.type || type });
  } catch {
    return original;
  } finally {
    decoded.close();
  }
}
