import { useEffect, useState, type ReactNode } from "react";

// 閉じるときも、開くときと同じ向きに動かしてから消す（いきなり消えると「戻る」の動きが途切れて見えるため）。
// value が null になっても、ms のあいだは直前の中身を残し、leaving の印（is-leaving）を付ける。
// 閉じている途中はクリックを受けないので、二度押しで二回戻ることもない（CSS の pointer-events: none）。
export function ExitMotion<T>({
  value,
  ms = 200,
  children
}: {
  value: T | null;
  ms?: number;
  children: (value: T) => ReactNode;
}) {
  const [shown, setShown] = useState<T | null>(value);
  const [leaving, setLeaving] = useState(false);

  // 開く・中身が変わるときは、その場で反映する（描画中の state 更新は React が認めた書き方）
  if (value !== null && (value !== shown || leaving)) {
    setShown(value);
    setLeaving(false);
  }
  if (value === null && shown !== null && !leaving) setLeaving(true);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [leaving, ms]);

  if (shown === null) return null;
  // display: contents なので、レイアウトにも重なり順にも影響しない（中の .page はこれまで通り全画面）
  return <div className={leaving ? "exit-scope is-leaving" : "exit-scope"}>{children(shown)}</div>;
}
