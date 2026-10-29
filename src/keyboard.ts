// iOS のキーボード表示を追跡し、高さを CSS 変数 --kb（px）として <html> に書き込む。
// 入力欄（.composer）だけをこの分だけ持ち上げ、画面全体は動かさない。
// 画面全体は body を固定（position: fixed）しているので、iOS がページを
// スクロールしてしまうことがなく、閉じたあとに下が空白になることもない。
export function trackKeyboard(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => undefined;

  const root = document.documentElement;
  let frame = 0;

  const update = () => {
    frame = 0;
    // レイアウト画面の下端と、見えている領域の下端との差 = キーボードの高さ
    const hidden = window.innerHeight - vv.height - vv.offsetTop;
    const kb = Math.max(0, Math.round(hidden));
    root.style.setProperty("--kb", `${kb}px`);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  update();

  return () => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
