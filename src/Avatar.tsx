import { useEffect, useState } from "react";
import { cachedAvatar, onAvatarCacheChange } from "./avatarCache";
import { RobotFace, SENNIN_BOT_ID } from "./robot";

// 写真があれば写真、なければ名前の1文字。src を渡すとグループなど別の画像URLを使う
// 友だちの画像は、保存済みのものがあればデータベースに問い合わせる前にすぐ表示する
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

  useEffect(() => {
    if (src || !userId) return;
    const update = () => setSaved(hasAvatar ? cachedAvatar(userId) : null);
    update();
    return onAvatarCacheChange(update);
  }, [userId, hasAvatar, src]);

  useEffect(() => setFailed(false), [userId, src, saved]);

  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (userId === SENNIN_BOT_ID) {
    return (
      <span className="avatar" style={style} aria-hidden="true">
        <RobotFace />
      </span>
    );
  }
  const url = src ?? saved ?? (userId ? `/api/users/${userId}/avatar` : "");
  if (!url || !hasAvatar || failed) {
    return (
      <span className="avatar" style={style} aria-hidden="true">
        {initial}
      </span>
    );
  }
  return <img className="avatar" style={style} src={url} alt="" onError={() => setFailed(true)} />;
}
