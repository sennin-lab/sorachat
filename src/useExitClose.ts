import { useCallback, useEffect, useRef, useState } from "react";

// モーダルを閉じるとき、退場のアニメーションを流してから onClose を呼ぶ。
// close(then) は、閉じた後に then（送信など）を先に実行する。二重に呼ばれても一度だけ動く。
export function useExitClose(onClose: () => void, ms = 220) {
  const [closing, setClosing] = useState(false);
  const started = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latestOnClose = useRef(onClose);
  latestOnClose.current = onClose;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const close = useCallback(
    (then?: () => void) => {
      if (started.current) return;
      started.current = true;
      setClosing(true);
      timer.current = window.setTimeout(() => {
        then?.();
        latestOnClose.current();
      }, ms);
    },
    [ms]
  );

  return { closing, close };
}
