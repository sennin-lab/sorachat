import { useState } from "react";

// 写真があれば写真、なければ名前の1文字。src を渡すとグループなど別の画像URLを使う
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
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  const url = src ?? (userId ? `/api/users/${userId}/avatar` : "");
  if (!url || !hasAvatar || failed) {
    return (
      <span className="avatar" style={style} aria-hidden="true">
        {initial}
      </span>
    );
  }
  return <img className="avatar" style={style} src={url} alt="" onError={() => setFailed(true)} />;
}
