import { randomUUID } from "node:crypto";
import multer from "multer";
import { IMAGE_BUCKET, sb } from "./supabase.js";

export const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const isAllowedImage = (file?: Express.Multer.File) => Boolean(file && IMAGE_TYPES[file.mimetype]);

export async function saveImage(file: Express.Multer.File, folder: string) {
  const path = `${folder}/${randomUUID()}.${IMAGE_TYPES[file.mimetype]}`;
  const { error } = await sb.storage.from(IMAGE_BUCKET).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: false
  });
  if (error) throw error;
  return path;
}

export async function readImage(path: string) {
  const { data, error } = await sb.storage.from(IMAGE_BUCKET).download(path);
  if (error || !data) return null;
  return { buffer: Buffer.from(await data.arrayBuffer()), type: data.type || "application/octet-stream" };
}

export async function removeImage(path: string | null) {
  if (path) await sb.storage.from(IMAGE_BUCKET).remove([path]);
}
