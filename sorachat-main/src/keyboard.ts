// iOS のキーボード表示に合わせて、アプリの領域を「見えている部分」だけに揃える。
// 入力欄を transform で動かすのではなく、アプリ全体の top / height を
// visualViewport に合わせて変えるため、入力欄は最初から表示領域の最下部に
// 固定されたままになり、ずれたり遅れて動いたりしない。
export function trackKeyboard(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => undefined;

  const root = document.documentElement;
  let frame = 0;

  const update = () => {
    frame = 0;
    // 閉じた状態でも開いた状態でも、チャットの下端を見えている部分の下端に合わせる
    const thread = document.querySelector<HTMLElement>(".thread");
    // 高さが変わる前に「一番下を見ていたか」を覚えておく
    const wasAtBottom = !!thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;

    // キーボードが出ているかどうか（出ている間はタブバーを隠す）
    root.dataset.kb = vv.height < window.innerHeight - 120 ? "open" : "closed";

    root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);

    // 高さが縮んだあとも、一番下を見ていた場合は最新のメッセージが隠れないように戻す
    if (thread && wasAtBottom) thread.scrollTop = thread.scrollHeight;
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
