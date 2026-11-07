import { useEffect, useState } from "react";
import { avatarObjectUrl, cachedAvatar, knownAvatarVersion, onAvatarCacheChange } from "./avatarCache";
import { RobotFace, SENNIN_BOT_ID } from "./robot";

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

  useEffect(() => setFailed(false), [userId, src, saved, dbUrl]);

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
  const remote = `/api/users/${userId}/avatar${version ? `?v=${encodeURIComponent(version)}` : ""}`;
  const url = src ?? saved ?? fromDb ?? (userId && dbUrl !== undefined ? remote : "");
  if (!url || !hasAvatar || failed) {
    return (
      <span className="avatar" style={style} aria-hidden="true">
        {initial}
      </span>
    );
  }
  return <img className="avatar" style={style} src={url} alt="" onError={() => setFailed(true)} />;
}
