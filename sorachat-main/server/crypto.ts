import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// メッセージ本文・一覧のプレビューを、DBに保存する前に AES-256-GCM で暗号化する。
// 鍵は環境変数 MESSAGE_ENCRYPTION_KEY（32バイトの乱数を base64 にしたもの）。
// 鍵がない・長さが違う場合は起動時に止める（平文のまま保存されないように）。
//
// 保存形式: "v1:" + base64(iv(12) | tag(16) | 暗号文)
// 暗号化は「通信中（HTTPS）」と「DBの中身」の両方を守るが、サーバーは鍵を持つので復号できる（運営・admin が閲覧可能）。

const PREFIX = "v1:";

const loadKey = (): Buffer => {
  const raw = process.env.MESSAGE_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("MESSAGE_ENCRYPTION_KEY を設定してください（32バイトの乱数を base64 にしたもの。例: openssl rand -base64 32）。");
  }
  return key;
};

const KEY = loadKey();

export const isEncrypted = (value: string) => value.startsWith(PREFIX);

export function encryptText(plain: string): string;
export function encryptText(plain: null): null;
export function encryptText(plain: string | null): string | null;
export function encryptText(plain: string | null): string | null {
  if (plain === null) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, data]).toString("base64");
}

export function decryptText(value: string): string;
export function decryptText(value: null): null;
export function decryptText(value: string | null): string | null;
export function decryptText(value: string | null): string | null {
  if (value === null) return null;
  // 移行前の平文はそのまま返す（移行スクリプトで暗号化していく）
  if (!isEncrypted(value)) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    // 改ざんされている、または鍵が違う場合
    return "[復号できませんでした]";
  }
}
