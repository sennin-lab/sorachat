// 連打バトル・反射神経バトルの進行（純粋な reduce / viewOf）の確認。DB には接続しない。
import assert from "node:assert/strict";
const { reduce, viewOf, TIMING, REFLEX_ROUNDS, TAP_MAX_PER_SECOND, TAP_GRACE, GameError } = await import("../server/gameLogic.ts");

const A = "user-a";
const B = "user-b";
const players = [A, B];
const start = (kind: "tap" | "reflex", now: number, random = () => 0.5) =>
  reduce(kind, A, { players: [...players], cancelled: false, play: null }, A, { action: "start" }, random, undefined, now).stored;
const act = (kind: "tap" | "reflex", stored: any, me: string, input: any, now: number, random = () => 0.5) =>
  reduce(kind, A, stored, me, input, random, undefined, now).stored;
const tick = (kind: "tap" | "reflex", stored: any, now: number, random = () => 0.5) =>
  reduce(kind, A, stored, "", { action: "tick" }, random, undefined, now).stored;

// ---- 連打バトル ----
{
  let t = 1_000_000;
  let s = start("tap", t);
  assert.equal(s.play.kind, "tap");
  assert.equal(s.play.phase, "count", "最初はカウントダウン");
  // 送っても、まだ始まっていないので数えない
  assert.throws(() => act("tap", s, A, { action: "tap", value: 5 }, t), GameError);

  t += TIMING.tapCountdown;
  s = tick("tap", s, t);
  assert.equal(s.play.phase, "run", "カウントダウンのあと連打が始まる");

  s = act("tap", s, A, { action: "tap", value: 10 }, t + 100);
  s = act("tap", s, B, { action: "tap", value: 3 }, t + 100);
  assert.equal(s.play.counts[A], 10);
  assert.equal(s.play.counts[B], 3);

  // 開始直後に大量に送っても、経過時間の上限（14回/秒 + 余裕）で止まる
  const cap1s = TAP_MAX_PER_SECOND * 1 + TAP_GRACE;
  let burst = start("tap", t - TIMING.tapCountdown);
  burst = act("tap", burst, A, { action: "tap", value: 30 }, t + 1_000);
  burst = act("tap", burst, A, { action: "tap", value: 30 }, t + 1_000);
  assert.ok(burst.play.counts[A] <= cap1s, `1秒で ${cap1s} 回を超えて数えない（実際: ${burst.play.counts[A]}）`);

  // 制限時間が過ぎたら終わり
  s = tick("tap", s, t + TIMING.tapRun + 1_000);
  assert.equal(s.play.phase, "done", "連打の時間が過ぎたら終わる");
  const view = viewOf("tap", A, s, "done", A, t + TIMING.tapRun + 1_000);
  assert.equal(view.tap?.phase, "done");
  assert.equal(view.tap?.deadlineIn, null);
  console.log("ok: 連打バトルの進行と上限");
}

// ---- 反射神経バトル ----
{
  let t = 2_000_000;
  // random=0 なら待ち時間は最短
  let s = start("reflex", t, () => 0);
  assert.equal(s.play.kind, "reflex");
  assert.equal(s.play.phase, "wait");
  const goAt = s.play.goAt as number;
  assert.equal(goAt - t, TIMING.reflexWaitMin, "待ち時間は最短（random=0）");

  // 待っている間の画面は、締め切り（GO の時刻）を見せない
  const waitView = viewOf("reflex", A, s, "playing", A, t + 100);
  assert.equal(waitView.reflex?.phase, "wait");
  assert.equal(waitView.reflex?.deadlineIn, null, "GO の前は残り時間を出さない");

  // GO の前に押したら、フライング（このラウンドは点なし）
  s = act("reflex", s, B, { action: "react" }, t + 500);
  assert.deepEqual(s.play.falseStart, [B]);

  // GO の合図
  s = tick("reflex", s, goAt, () => 0);
  assert.equal(s.play.phase, "go");

  // A は 300ms 後に押した。往復 100ms があるので、反応は 300 - 100 = 200ms になる（補正）
  s = reduce("reflex", A, s, A, { action: "react", rttMs: 100 }, () => 0, undefined, goAt + 300).stored;
  assert.equal(s.play.reacted[A], 200, "往復時間を差し引いた反応時間");
  // 同じ人は二度押せない
  assert.throws(() => act("reflex", s, A, { action: "react" }, goAt + 320), GameError);

  // A がもう押しているので、B がフライングのままなら、この時点でラウンドは終わる
  assert.equal(s.play.phase, "revealed", "全員の反応がそろったらラウンドを締める");
  assert.equal(s.play.scores[A], 1, "一番早い人に1点");
  assert.equal(s.play.last.times[B], null, "フライングは反応時間なし");

  // 次のラウンドへ（表示の時間のあと）
  let now = goAt + 300 + TIMING.reflexReveal;
  s = tick("reflex", s, now, () => 0);
  assert.equal(s.play.round, 2);
  assert.equal(s.play.phase, "wait");
  assert.deepEqual(s.play.falseStart, [], "次のラウンドでは、フライングは消える");

  // 押さない人がいても、GO から時間切れで次へ（点は付かない）
  const goAt2 = s.play.goAt as number;
  s = tick("reflex", s, goAt2, () => 0);
  s = tick("reflex", s, goAt2 + TIMING.reflexGoWindow, () => 0);
  assert.equal(s.play.phase, "revealed", "時間切れで締める");
  assert.equal(s.play.last.winner, null);

  // 残りのラウンドを最後まで進める
  now = goAt2 + TIMING.reflexGoWindow + TIMING.reflexReveal;
  for (let round = 3; round <= REFLEX_ROUNDS; round++) {
    s = tick("reflex", s, now, () => 0);
    const go = s.play.goAt as number;
    s = tick("reflex", s, go, () => 0);
    s = reduce("reflex", A, s, A, { action: "react", rttMs: 0 }, () => 0, undefined, go + 250).stored;
    s = reduce("reflex", A, s, B, { action: "react", rttMs: 0 }, () => 0, undefined, go + 400).stored;
    now = s.play.deadline as number;
  }
  s = tick("reflex", s, now, () => 0);
  assert.equal(s.play.phase, "done", "全ラウンドが終わったら完了");
  // 1ラウンド目と3ラウンド目は勝ち、2ラウンド目は時間切れで点なし
  assert.equal(s.play.scores[A], 2, "勝ったラウンドだけ点が付く");
  console.log("ok: 反射神経バトルの進行・フライング・補正");
}

console.log("すべて合格");
