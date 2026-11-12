import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GameHand, GameKind, GameView } from "./types";

export const GAME_TITLES: Record<GameKind, string> = {
  tictactoe: "三目並べ",
  quiz: "早押しクイズ",
  janken: "じゃんけん大会",
  guess: "数当て",
  tap: "連打バトル",
  reflex: "反射神経バトル"
};

// 操作を送る関数。成功なら true、できなかったら false（Promise でも、何も返さなくてもよい）
type ActionFn = (action: string, extra?: Record<string, unknown>) => Promise<boolean> | void;

const HAND_LABEL: Record<GameHand, string> = { rock: "✊ グー", scissors: "✌ チョキ", paper: "✋ パー" };

type Props = {
  game: GameView;
  // メンバーの表示名（ユーザーID → 名前）
  names: Map<string, string>;
  onAction: ActionFn;
};

// ミニゲームの吹き出しの中身。操作はすべてサーバーに送り、結果は全員の画面に届く
// 「全画面」を押すと、同じ中身を画面いっぱいに出す（状態は同じものを見ているので、ずれない）
export function GameCard(props: Props) {
  const [full, setFull] = useState(false);
  // 全画面は、ボタンを押した瞬間に要求する（ブラウザは操作の直後でないと許可しないため）
  const expand = () => {
    if (typeof document.documentElement.requestFullscreen === "function") {
      document.documentElement.requestFullscreen().catch(() => undefined);
    }
    setFull(true);
  };
  return (
    <>
      <GameBody {...props} onExpand={expand} />
      {full && (
        <GameFullscreen title={GAME_TITLES[props.game.kind]} onClose={() => setFull(false)}>
          <GameBody {...props} />
        </GameFullscreen>
      )}
    </>
  );
}

// 締め切りまでの残り秒数。サーバーは「あと何ミリ秒」で送ってくるので、受け取った時点から数える
function useCountdown(remainingMs: number | null | undefined): number | null {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const endAt = useMemo(() => (typeof remainingMs === "number" ? Date.now() + remainingMs : null), [remainingMs]);
  useEffect(() => {
    if (endAt === null) return;
    const timer = window.setInterval(() => tick(), 250);
    return () => window.clearInterval(timer);
  }, [endAt]);
  if (endAt === null) return null;
  return Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
}

// 時間の表示（残りが少ないと赤くする）
function Timer({ seconds, label }: { seconds: number; label: string }) {
  return (
    <span className={`game-timer${seconds <= 3 ? " urgent" : ""}`}>
      {label} <strong>{seconds}</strong>秒
    </span>
  );
}

// 全画面の表示。端末が対応していれば本当の全画面にし、非対応（iPhoneなど）でも画面いっぱいに広げる
function GameFullscreen({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let entered = false;
    const onFullscreenChange = () => {
      if (document.fullscreenElement) entered = true;
      // 端末側の操作で全画面が解除されたら、画面も閉じる
      else if (entered) closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
        document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  // 吹き出しのクリックや長押しが、チャット側に伝わらないようにする
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return createPortal(
    <div className="game-fs" role="dialog" aria-modal="true" aria-label={title} onClick={stop} onPointerDown={stop} onTouchStart={stop}>
      <div className="game-fs-bar">
        <strong>{title}</strong>
        <button type="button" className="btn-small" onClick={() => onClose()}>
          閉じる
        </button>
      </div>
      <div className="game-fs-body">
        <div className="game-fs-inner">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function GameBody({ game, names, onAction, onExpand }: Props & { onExpand?: () => void }) {
  const nameOf = (uid: string | null | undefined) => (uid === game.me ? "あなた" : uid ? names.get(uid) ?? "メンバー" : "");
  const joined = game.players.includes(game.me);
  const isCreator = game.me === game.creatorId;
  const finished = game.status === "finished";
  const canPlay = game.status === "playing" && joined;

  return (
    <div className="game-card" onClick={(e) => e.stopPropagation()}>
      <div className="game-head">
        <strong>{GAME_TITLES[game.kind]}</strong>
        {game.status === "waiting" && <span className="game-chip">募集中</span>}
        {game.status === "playing" && <span className="game-chip live">対戦中</span>}
        {finished && <span className="game-chip">{game.cancelled ? "中止" : "終了"}</span>}
        {onExpand && (
          <button type="button" className="game-expand" onClick={() => onExpand()} aria-label="全画面で遊ぶ">
            全画面
          </button>
        )}
      </div>

      {game.status === "waiting" && (
        <div className="game-waiting">
          <p className="game-meta">
            参加 {game.players.length}/{game.max}人（{game.min}人からできます）
          </p>
          <ul className="game-players">
            {game.players.map((uid) => (
              <li key={uid}>
                {nameOf(uid)}
                {uid === game.creatorId && <small>（作成）</small>}
              </li>
            ))}
          </ul>
          <p className="game-meta">
            {game.kind === "tictactoe" ? "2人目が参加すると、その場で始まります" : "作った人が「開始」を押すと始まります"}
          </p>
          <div className="game-actions">
            {!joined && game.players.length < game.max && (
              <button type="button" className="btn-small accent" onClick={() => onAction("join")}>
                参加する
              </button>
            )}
            {isCreator && game.players.length >= game.min && (
              <button type="button" className="btn-small accent" onClick={() => onAction("start")}>
                開始
              </button>
            )}
            {isCreator && (
              <button type="button" className="btn-small danger" onClick={() => onAction("cancel")}>
                中止
              </button>
            )}
          </div>
        </div>
      )}

      {game.tictactoe && (
        <TicTacToe game={game} nameOf={nameOf} canPlay={canPlay} onAction={onAction} />
      )}
      {game.quiz && <Quiz game={game} nameOf={nameOf} canPlay={canPlay} onAction={onAction} />}
      {game.janken && <Janken game={game} nameOf={nameOf} canPlay={canPlay} onAction={onAction} />}
      {game.guess && <Guess game={game} nameOf={nameOf} canPlay={canPlay} onAction={onAction} />}
      {game.tap && <TapBattle game={game} nameOf={nameOf} canPlay={canPlay} onAction={onAction} />}
      {game.reflex && <ReflexBattle game={game} nameOf={nameOf} canPlay={canPlay} onAction={onAction} />}

      {finished && game.cancelled && <p className="game-result">ゲームは中止されました</p>}
      {game.status !== "waiting" && isCreator && !finished && (
        <div className="game-actions">
          <button type="button" className="btn-small danger" onClick={() => onAction("cancel")}>
            中止
          </button>
        </div>
      )}
    </div>
  );
}

type Sub = {
  game: GameView;
  nameOf: (uid: string | null | undefined) => string;
  canPlay: boolean;
  onAction: ActionFn;
};

function TicTacToe({ game, nameOf, canPlay, onAction }: Sub) {
  const t = game.tictactoe!;
  const mark = (symbol: "X" | "O") => (symbol === "X" ? "×" : "○");
  const mySymbol = game.me === t.symbols.X ? "X" : game.me === t.symbols.O ? "O" : null;
  const myTurn = canPlay && game.status === "playing" && mySymbol !== null && t.turn === mySymbol;
  // 押した瞬間に自分の印を出す（楽観的な表示）。新しい画面の情報が届いたとき（成功でも失敗でも）に消して、サーバーの状態に合わせる
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    setPending(null);
  }, [t]);
  const place = (index: number) => {
    if (!myTurn || pending !== null || t.board[index]) return;
    setPending(index);
    void Promise.resolve(onAction("move", { index })).then((ok) => {
      if (ok === false) setPending(null);
    });
  };
  const turnUid = t.turn === "X" ? t.symbols.X : t.symbols.O;
  let message = "";
  if (t.winner === "draw") message = "引き分けです";
  else if (t.winner) message = `${nameOf(t.winner === "X" ? t.symbols.X : t.symbols.O)}の勝ち！`;
  else message = `${nameOf(turnUid)}の番（${mark(t.turn)}）`;
  return (
    <div className="ttt">
      <p className="game-meta">
        × {nameOf(t.symbols.X)}　○ {nameOf(t.symbols.O)}
      </p>
      <div className="ttt-board">
        {t.board.map((cell, i) => (
          <button
            key={i}
            type="button"
            className={`ttt-cell${t.line?.includes(i) ? " win" : ""}`}
            disabled={!myTurn || Boolean(cell) || pending !== null}
            onClick={() => place(i)}
            aria-label={`${i + 1}番のマス`}
          >
            {cell ? mark(cell as "X" | "O") : pending === i && mySymbol ? mark(mySymbol) : ""}
          </button>
        ))}
      </div>
      <p className="game-result">{message}</p>
    </div>
  );
}

function Quiz({ game, nameOf, canPlay, onAction }: Sub) {
  const q = game.quiz!;
  const seconds = useCountdown(q.deadlineIn);
  const amBuzzer = q.buzzed === game.me;
  const canBuzz = canPlay && q.phase === "question" && !q.buzzed && !q.tried.includes(game.me);
  const ranking = game.players
    .map((uid) => ({ uid, score: q.scores[uid] ?? 0 }))
    .sort((a, b) => b.score - a.score);

  if (q.phase === "done") {
    const top = ranking[0]?.score ?? 0;
    const winners = ranking.filter((r) => r.score === top).map((r) => nameOf(r.uid));
    return (
      <div className="quiz">
        <p className="game-result">{winners.join("・")}の優勝！</p>
        <ScoreList ranking={ranking} nameOf={nameOf} />
      </div>
    );
  }

  const result = q.result;
  let message = "";
  if (q.phase === "revealed" && result) {
    message = result.correct
      ? `${nameOf(result.by)}が正解！`
      : `正解は「${q.options[result.answer]}」でした`;
  } else if (q.buzzed) {
    message = amBuzzer ? "答えを選んでください" : `${nameOf(q.buzzed)}が回答中…`;
  } else if (q.tried.length) {
    message = `不正解：${q.tried.map((uid) => nameOf(uid)).join("、")}。ほかの人は押せます`;
  } else {
    message = "問題が出ました。早押し！";
  }

  const lastRound = q.round + 1 >= q.total;
  return (
    <div className="quiz">
      <p className="game-meta">
        第{q.round + 1}問 / {q.total}問
        {seconds !== null && (
          <>
            {" ・ "}
            <Timer seconds={seconds} label={q.phase === "revealed" ? "次の問題まで" : "残り"} />
          </>
        )}
      </p>
      <p className="quiz-question">{q.question}</p>
      <div className="quiz-options">
        {q.options.map((option, i) => {
          const correct = q.phase === "revealed" && result?.answer === i;
          const wrong = q.phase === "revealed" && result?.choice === i && !result.correct;
          return (
            <button
              key={i}
              type="button"
              className={`quiz-option${correct ? " correct" : ""}${wrong ? " wrong" : ""}`}
              disabled={!(amBuzzer && q.phase === "question" && canPlay)}
              onClick={() => onAction("answer", { choice: i })}
            >
              {option}
            </button>
          );
        })}
      </div>
      {canBuzz && (
        <button type="button" className="quiz-buzz" onClick={() => onAction("buzz")}>
          押す！
        </button>
      )}
      <p className="game-result">{message}</p>
      {q.phase === "revealed" && canPlay && (
        <div className="game-actions">
          <button type="button" className="btn-small accent" onClick={() => onAction("next")}>
            {lastRound ? "結果を見る" : "次の問題へ"}
          </button>
        </div>
      )}
      <ScoreList ranking={ranking} nameOf={nameOf} />
    </div>
  );
}

function ScoreList({ ranking, nameOf }: { ranking: { uid: string; score: number }[]; nameOf: (uid: string) => string }) {
  return (
    <ul className="game-scores">
      {ranking.map((r) => (
        <li key={r.uid}>
          <span>{nameOf(r.uid)}</span>
          <strong>{r.score}点</strong>
        </li>
      ))}
    </ul>
  );
}

function Janken({ game, nameOf, canPlay, onAction }: Sub) {
  const j = game.janken!;
  const seconds = useCountdown(j.deadlineIn);
  const amAlive = j.alive.includes(game.me);
  const isChampionRound = Boolean(j.champion);

  if (j.phase === "done") {
    return <p className="game-result">{j.champion ? `${nameOf(j.champion)}が優勝！` : "ゲームが終わりました"}</p>;
  }

  if (j.phase === "revealed" && j.last) {
    const last = j.last;
    const outcome =
      last.outcome === "draw"
        ? "あいこ！ もう一度"
        : `${last.winningHand ? HAND_LABEL[last.winningHand] : ""}の勝ち。${last.eliminated.map((uid) => nameOf(uid)).join("、")}が敗退`;
    return (
      <div className="janken">
        <p className="game-meta">
          第{j.round}回の結果
          {seconds !== null && (
            <>
              {" ・ "}
              <Timer seconds={seconds} label="次へ" />
            </>
          )}
        </p>
        <ul className="game-scores">
          {Object.entries(last.hands).map(([uid, hand]) => (
            <li key={uid}>
              <span>{nameOf(uid)}</span>
              <strong>{HAND_LABEL[hand]}</strong>
            </li>
          ))}
        </ul>
        <p className="game-result">{outcome}</p>
        {isChampionRound && <p className="game-result">{nameOf(j.champion)}が優勝！</p>}
        {canPlay && (
          <div className="game-actions">
            <button type="button" className="btn-small accent" onClick={() => onAction("next")}>
              {isChampionRound ? "結果を確定" : "次の回へ"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="janken">
      <p className="game-meta">
        第{j.round}回　残り{j.alive.length}人
        {seconds !== null && (
          <>
            {" ・ "}
            <Timer seconds={seconds} label="残り" />
          </>
        )}
      </p>
      {canPlay && amAlive && !j.myHand && seconds !== null && <p className="game-meta">時間内に出さないと、ランダムの手になります</p>}
      {canPlay && amAlive && !j.myHand && (
        <div className="janken-hands">
          {(Object.keys(HAND_LABEL) as GameHand[]).map((hand) => (
            <button key={hand} type="button" className="janken-hand" onClick={() => onAction("hand", { hand })}>
              {HAND_LABEL[hand]}
            </button>
          ))}
        </div>
      )}
      {j.myHand && <p className="game-result">{HAND_LABEL[j.myHand]} を出しました</p>}
      {!amAlive && <p className="game-meta">あなたは敗退しました（観戦中）</p>}
      <ul className="game-players">
        {j.alive.map((uid) => (
          <li key={uid}>
            {nameOf(uid)}
            <small>{j.submitted.includes(uid) ? "　✓ 出しました" : "　…待っています"}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Guess({ game, nameOf, canPlay, onAction }: Sub) {
  const g = game.guess!;
  const [value, setValue] = useState("");
  const finished = game.status === "finished";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const number = Number(value);
    if (!Number.isInteger(number) || number < g.min || number > g.max) return;
    setValue("");
    onAction("guess", { value: number });
  };
  const hint = (result: "higher" | "lower" | "correct") =>
    result === "correct" ? "正解！" : result === "higher" ? "もっと大きい" : "もっと小さい";
  return (
    <div className="guess">
      <p className="game-meta">
        {g.min}〜{g.max}の秘密の数字を当ててください
      </p>
      {finished && g.winner && (
        <p className="game-result">
          {nameOf(g.winner)}が正解！ 答えは {g.secret}
        </p>
      )}
      {canPlay && !finished && (
        <form className="guess-form" onSubmit={submit}>
          <input
            type="number"
            inputMode="numeric"
            min={g.min}
            max={g.max}
            value={value}
            placeholder={`${g.min}〜${g.max}`}
            onChange={(e) => setValue(e.target.value)}
            aria-label="数字"
          />
          <button type="submit" className="btn-small accent" disabled={!value}>
            送る
          </button>
        </form>
      )}
      <ul className="guess-log">
        {g.guesses.map((item, i) => (
          <li key={i}>
            <span>{nameOf(item.by)}：{item.value}</span>
            <strong className={item.result === "correct" ? "hit" : ""}>{hint(item.result)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- 連打バトル（10秒間の連打。押した分は少しずつまとめて送る）----
const TAP_FLUSH_MS = 100;
const TAP_BATCH_MAX = 30;

function TapBattle({ game, nameOf, canPlay, onAction }: Sub) {
  const tap = game.tap!;
  const seconds = useCountdown(tap.deadlineIn);
  const running = tap.phase === "run" && canPlay;
  // localTotal：自分が押した合計。acked：サーバーが受け付けた合計。unsent：まだ送っていない分
  const localTotal = useRef(0);
  const acked = useRef(0);
  const unsent = useRef(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  // まとめて送る（送った分は、結果が届くまで「未確定」として画面に足す）
  const flush = () => {
    while (unsent.current > 0) {
      const n = Math.min(TAP_BATCH_MAX, unsent.current);
      unsent.current -= n;
      Promise.resolve(onActionRef.current("tap", { value: n })).then(
        (ok) => {
          if (ok === false) localTotal.current -= n;
          else acked.current += n;
          bump();
        },
        () => {
          localTotal.current -= n;
          bump();
        }
      );
    }
  };

  // 実行中だけ一定間隔で送る。終わるとき（画面から離れるときも）残りを送る
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(flush, TAP_FLUSH_MS);
    return () => {
      window.clearInterval(timer);
      flush();
    };
    // flush は ref だけを使うので、実行中の切り替えだけで張り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const press = (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!running) return;
    localTotal.current += 1;
    unsent.current += 1;
    if (unsent.current >= TAP_BATCH_MAX) flush();
    bump();
  };

  const serverMine = tap.counts[game.me] ?? 0;
  const mine = serverMine + (localTotal.current - acked.current);
  const counts = game.players.map((uid) => ({ uid, count: uid === game.me ? mine : tap.counts[uid] ?? 0 }));
  const ranking = [...counts].sort((a, b) => b.count - a.count);
  const topCount = Math.max(1, ...counts.map((c) => c.count));

  if (tap.phase === "count") {
    return (
      <div className="game-tap">
        <p className="game-big-label">まもなくスタート</p>
        <div className="game-big-number" aria-live="polite">
          {seconds ?? "…"}
        </div>
        <p className="game-meta">スタートしたら、大きなボタンを連打してください</p>
      </div>
    );
  }

  if (tap.phase === "done") {
    const top = ranking[0]?.count ?? 0;
    const winners = ranking.filter((r) => r.count === top).map((r) => nameOf(r.uid));
    return (
      <div className="game-tap">
        <p className="game-result">{winners.join("・")}の優勝！</p>
        <ol className="game-podium">
          {ranking.map((row, i) => (
            <li key={row.uid} className={`rank-${Math.min(i + 1, 4)}`}>
              <span className="game-rank">{i + 1}</span>
              <span className="game-podium-name">{nameOf(row.uid)}</span>
              <strong className="game-podium-count">{row.count}回</strong>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // 実行中
  return (
    <div className="game-tap">
      <div className="game-tap-head">
        {seconds !== null && <Timer seconds={seconds} label="残り" />}
        <span className="game-meta">あなた {mine}回</span>
      </div>
      <div
        className={`game-tap-pad${running ? "" : " off"}`}
        role="button"
        aria-disabled={!running}
        aria-label="タップ"
        onPointerDown={press}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span>タップ！</span>
        <strong>{mine}</strong>
      </div>
      <ul className="game-bars">
        {counts.map((row) => (
          <li key={row.uid} className={row.uid === game.me ? "me" : ""}>
            <span className="game-bar-name">{nameOf(row.uid)}</span>
            <span className="game-bar-track">
              <span className="game-bar-fill" style={{ width: `${Math.max(3, (row.count / topCount) * 100)}%` }} />
            </span>
            <strong className="game-bar-count">{row.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- 反射神経バトル（GO で一番早く押した人が1点。3ラウンド）----
function ReflexBattle({ game, nameOf, canPlay, onAction }: Sub) {
  const r = game.reflex!;
  const seconds = useCountdown(r.deadlineIn);
  // 自分が押したラウンド（押した瞬間の表示に使う。失敗したら戻す）
  const [pressedRound, setPressedRound] = useState<number | null>(null);
  const pressedHere = pressedRound === r.round;
  const iFlying = r.falseStart.includes(game.me) || (pressedHere && r.phase === "wait");
  const iDone = pressedHere || r.reacted.includes(game.me) || r.falseStart.includes(game.me);
  const padActive = canPlay && (r.phase === "wait" || r.phase === "go") && !iDone;

  const press = (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!padActive) return;
    setPressedRound(r.round);
    void Promise.resolve(onAction("react")).then((ok) => {
      if (ok === false) setPressedRound(null);
    });
  };

  const ranking = game.players.map((uid) => ({ uid, score: r.scores[uid] ?? 0 })).sort((a, b) => b.score - a.score);
  const roundLabel = `ラウンド ${r.round} / ${r.total}`;

  if (r.phase === "done") {
    const top = ranking[0]?.score ?? 0;
    const winners = ranking.filter((x) => x.score === top).map((x) => nameOf(x.uid));
    return (
      <div className="game-reflex">
        <p className="game-result">{winners.join("・")}の優勝！（{top}点）</p>
        <ol className="game-podium">
          {ranking.map((row, i) => (
            <li key={row.uid} className={`rank-${Math.min(i + 1, 4)}`}>
              <span className="game-rank">{i + 1}</span>
              <span className="game-podium-name">{nameOf(row.uid)}</span>
              <strong className="game-podium-count">{row.score}点</strong>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (r.phase === "revealed" && r.last) {
    const last = r.last;
    const order = [...game.players].sort((a, b) => {
      const ta = last.times[a] ?? Infinity;
      const tb = last.times[b] ?? Infinity;
      return ta - tb;
    });
    return (
      <div className="game-reflex">
        <p className="game-meta">{roundLabel}</p>
        <p className="game-result">{last.winner ? `${nameOf(last.winner)}が1点！` : "今回は点が入りませんでした"}</p>
        <ul className="game-times">
          {order.map((uid) => {
            const ms = last.times[uid];
            const flying = last.falseStart.includes(uid);
            return (
              <li key={uid} className={uid === last.winner ? "win" : ""}>
                <span>{nameOf(uid)}</span>
                <strong>{flying ? "フライング" : ms === null || ms === undefined ? "押せず" : `${ms}ms`}</strong>
                {uid === last.winner && <em>1点</em>}
              </li>
            );
          })}
        </ul>
        <ScoreList ranking={ranking} nameOf={nameOf} />
        {seconds !== null && <p className="game-meta">次のラウンドまで {seconds}秒</p>}
      </div>
    );
  }

  // 待機（GOの前）・GO
  const isGo = r.phase === "go";
  const label = iFlying ? "フライング…" : isGo ? (iDone ? "押した！" : "押せ！") : "まだ…";
  return (
    <div className="game-reflex">
      <div className="game-tap-head">
        <span className="game-meta">{roundLabel}</span>
        {isGo && seconds !== null && <Timer seconds={seconds} label="残り" />}
      </div>
      <div
        className={`game-reflex-pad ${isGo ? "go" : "wait"}${iDone ? " pressed" : ""}${padActive ? "" : " off"}`}
        role="button"
        aria-disabled={!padActive}
        aria-label="押す"
        onPointerDown={press}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span>{label}</span>
        {!isGo && <small>GOが出るまで待ってください</small>}
        {r.myMs !== null && <small>あなた {r.myMs}ms</small>}
      </div>
      <ScoreList ranking={ranking} nameOf={nameOf} />
    </div>
  );
}
