import { useEffect, useState } from "react";
import { avatarObjectUrl, cachedAvatar, knownAvatarVersion, onAvatarCacheChange } from "./avatarCache";
import { RobotFace, SENNIN_BOT_ID } from "./robot";

// 一時的に読めなかった画像は、少し待って読み直す（ネットワークの一瞬の失敗で文字のアイコンに戻らないように）
const MAX_RETRY = 2;

// 写真があれば写真、なければ名前の1文字。src を渡すとグループなど別の画像URLを使う
// 友だちの画像は、保存済みのもの（localStorage → IndexedDB）があればデータベースに問い合わせる前に表示する
export function Avatar({
  userId,
  hasAvatar,
  name,
  size = 40,
  src
}: {
  userId: string;
  hasAvatar: boolean;
  name: string;
  size?: number;
  src?: string;
}) {
  const [failed, setFailed] = useState(false);
  // 読み直しの回数（増えると、URL に付けた印が変わり、ブラウザが取り直す）
  const [retry, setRetry] = useState(0);
  const [saved, setSaved] = useState<string | null>(() => (!src && userId && hasAvatar ? cachedAvatar(userId) : null));
  // IndexedDB から読んだ画像。undefined は「まだ確かめていない」、null は「保存なし」
  const [dbUrl, setDbUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (src || !userId) return;
    const update = () => setSaved(hasAvatar ? cachedAvatar(userId) : null);
    update();
    return onAvatarCacheChange(update);
  }, [userId, hasAvatar, src]);

  // localStorage に無いときだけ IndexedDB を見る
  useEffect(() => {
    setDbUrl(undefined);
    if (src || !userId || !hasAvatar || userId === SENNIN_BOT_ID) {
      setDbUrl(null);
      return;
    }
    let alive = true;
    const update = () => {
      avatarObjectUrl(userId).then((url) => {
        if (alive) setDbUrl(url);
      });
    };
    update();
    const off = onAvatarCacheChange(update);
    return () => {
      alive = false;
      off();
    };
  }, [userId, hasAvatar, src]);

  // 人や画像が変わったら、失敗の記録と読み直しの回数をリセットする
  useEffect(() => {
    setFailed(false);
    setRetry(0);
  }, [userId, src, saved, dbUrl, hasAvatar]);

  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (userId === SENNIN_BOT_ID) {
    return (
      <span className="avatar" style={style} aria-hidden="true">
        <RobotFace />
      </span>
    );
  }
  // 優先順：指定された画像 → localStorage → IndexedDB → 通常の読み込み（確かめ終わってから）
  const fromDb = dbUrl === undefined ? null : dbUrl;
  // 版（?v=）を付けると、画像が変わっていないあいだはブラウザに保存された分を使い、サーバーに取りに行かない
  const version = knownAvatarVersion(userId);
  const params = new URLSearchParams();
  if (version) params.set("v", version);
  // 読み直すときだけ印を付け、ブラウザが失敗した応答を使い回さないようにする
  if (retry > 0) params.set("r", String(retry));
  const query = params.toString();
  const remote = `/api/users/${userId}/avatar${query ? `?${query}` : ""}`;
  const url = src ?? saved ?? fromDb ?? (userId && dbUrl !== undefined ? remote : "");
  if (!url || !hasAvatar || failed) {
    return (
      <span className="avatar" style={style} aria-hidden="true">
        {initial}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      style={style}
      src={url}
      alt=""
      onError={() => {
        if (retry < MAX_RETRY) {
          // 少し待ってから読み直す（一時的な失敗なら、次の読み込みで表示される）
          window.setTimeout(() => setRetry((n) => n + 1), 600 * (retry + 1));
          return;
        }
        setFailed(true);
      }}
    />
  );
}
