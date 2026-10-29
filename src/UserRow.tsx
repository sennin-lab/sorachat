import type { CSSProperties, ReactNode } from "react";
import { Avatar } from "./Avatar";

// 友だち・検索結果・メンバーで共通に使う1行（LINE の友だちリストのような見た目）
export function UserRow({
  userId,
  hasAvatar,
  name,
  sub,
  right,
  onClick,
  check,
  index = 0
}: {
  userId: string;
  hasAvatar: boolean;
  name: string;
  sub?: string | null;
  right?: ReactNode;
  onClick?: () => void;
  // 指定されたときは行全体が選択用のチェック行になる
  check?: { checked: boolean; disabled?: boolean };
  index?: number;
}) {
  const body = (
    <>
      <Avatar userId={userId} hasAvatar={hasAvatar} name={name} size={50} />
      <span className="row-text">
        <strong>{name}</strong>
        {sub && <small>{sub}</small>}
      </span>
      {right}
      {check && <span className={`check-dot ${check.checked ? "on" : ""}`} aria-hidden="true" />}
    </>
  );
  const style = { "--i": Math.min(index, 14) } as CSSProperties;
  if (check) {
    return (
      <li className="user-li" style={style}>
        <button
          type="button"
          role="checkbox"
          aria-checked={check.checked}
          className={`user-row ${check.checked ? "checked" : ""}`}
          disabled={check.disabled}
          onClick={onClick}
        >
          {body}
        </button>
      </li>
    );
  }
  // 押せる行はボタン、押せない行（右側にボタンを置く行など）は普通の枠にする（ボタンの中にボタンは置けないため）
  if (onClick) {
    return (
      <li className="user-li" style={style}>
        <button type="button" className="user-row" onClick={onClick}>
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="user-li" style={style}>
      <div className="user-row">{body}</div>
    </li>
  );
}
