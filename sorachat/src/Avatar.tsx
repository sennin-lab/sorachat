import { useState } from "react";

export function Avatar({
  userId,
  hasAvatar,
  name,
  size = 40
}: {
  userId: string;
  hasAvatar: boolean;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (!userId || !hasAvatar || failed) {
    return (
      <span className="avatar" style={style} aria-hidden="true">
        {initial}
      </span>
    );
  }
  return <img className="avatar" style={style} src={`/api/users/${userId}/avatar`} alt="" onError={() => setFailed(true)} />;
}
