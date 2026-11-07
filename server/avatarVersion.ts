import { createHash } from "node:crypto";

// プロフィール画像の「版」。画像を変えると値も変わる短い印。
// 画像のパスそのものは出さず、ハッシュにして返す（画像がないときは null）。
// クライアントはこの値を見て、変わっていなければ保存済みの画像を使い、サーバーに取りに行かない。
export function avatarVersionOf(path: string | null | undefined): string | null {
  return path ? createHash("sha256").update(path).digest("hex").slice(0, 16) : null;
}
