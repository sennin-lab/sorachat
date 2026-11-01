import { randomUUID } from "node:crypto";
import multer from "multer";
import { IMAGE_BUCKET, sb } from "./supabase.js";
import { ensureBlobTable, tursoExecute } from "./turso.js";

export const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
export const FILE_LIMIT = 20 * 1024 * 1024;
export const uploadFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: FILE_LIMIT } });

// 日本語のファイル名がずれて届くことがあるので、UTF-8として読み直す
export function fileNameOf(file: Express.Multer.File) {
  const decoded = Buffer.from(file.originalname, "latin1").toString("utf8");
  const name = decoded.includes("�") ? file.originalname : decoded;
  return name.replace(/[\\/\r\n]/g, "_").trim().slice(0, 120) || "file";
}

const safeExt = (name: string) => {
  const match = name.match(/\.([a-zA-Z0-9]{1,10})$/);
  return match ? match[1].toLowerCase() : "bin";
};

// 中身は Turso（sc_blobs テーブル）に保存する。DB に入る path はこれまでと同じ形式
async function saveBlob(path: string, buffer: Buffer, contentType: string) {
  await ensureBlobTable();
  await tursoExecute("insert into sc_blobs (path, content_type, size, data) values (?, ?, ?, ?)", [
    { type: "text", value: path },
    { type: "text", value: contentType },
    { type: "integer", value: String(buffer.length) },
    { type: "blob", base64: buffer.toString("base64") }
  ]);
  return path;
}

// 任意ファイルは中身の型を信用せず application/octet-stream で保存する
export async function saveFile(file: Express.Multer.File, folder: string) {
  const path = `${folder}/${randomUUID()}.${safeExt(fileNameOf(file))}`;
  return saveBlob(path, file.buffer, "application/octet-stream");
}

export const isAllowedImage = (file?: Express.Multer.File) => Boolean(file && IMAGE_TYPES[file.mimetype]);

export async function saveImage(file: Express.Multer.File, folder: string) {
  const path = `${folder}/${randomUUID()}.${IMAGE_TYPES[file.mimetype]}`;
  return saveBlob(path, file.buffer, file.mimetype);
}

// Turso にあるものを返す。なければ、移行前に Supabase Storage へ保存されたものを返す
export async function readImage(path: string) {
  try {
    await ensureBlobTable();
    const rows = await tursoExecute("select content_type, data from sc_blobs where path = ? limit 1", [{ type: "text", value: path }]);
    const row = rows[0];
    if (row) {
      const typeValue = row[0];
      const dataValue = row[1];
      const type = typeValue && typeValue.type === "text" ? typeValue.value : "";
      const data = dataValue && dataValue.type === "blob" ? dataValue.base64 : "";
      return { buffer: Buffer.from(data, "base64"), type: type || "application/octet-stream" };
    }
  } catch (error) {
    console.error("画像の読み込み（Turso）に失敗しました:", error);
    return null;
  }
  return readLegacyImage(path);
}

// 移行前の Supabase Storage のファイル（既存データのため残す）
async function readLegacyImage(path: string) {
  const { data, error } = await sb.storage.from(IMAGE_BUCKET).download(path);
  if (error || !data) return null;
  return { buffer: Buffer.from(await data.arrayBuffer()), type: data.type || "application/octet-stream" };
}

export async function removeImage(path: string | null) {
  if (!path) return;
  try {
    await ensureBlobTable();
    await tursoExecute("delete from sc_blobs where path = ?", [{ type: "text", value: path }]);
  } catch (error) {
    console.error("画像の削除（Turso）に失敗しました:", error);
  }
  // 移行前の Supabase Storage に同じ path があれば消す（なければ何もしない）
  await sb.storage.from(IMAGE_BUCKET).remove([path]);
}
