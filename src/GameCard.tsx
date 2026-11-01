import { useState, type FormEvent } from "react";
import type { GameHand, GameKind, GameView } from "./types";

export const GAME_TITLES: Record<GameKind, string> = {
  tictactoe: "三目並べ",
  quiz: "早押しクイズ",
  janken: "じゃんけん大会",
  guess: "数当て"
};

const HAND_LABEL: Record<GameHand, string> = { rock: "✊ グー", scissors: "✌ チョキ", paper: "✋ パー" };

type Props = {
  game: GameView;
  // メンバーの表示名（ユーザーID → 名前）
  names: Map<string, string>;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
};

// ミニゲームの吹き出しの中身。操作はすべてサーバーに送り、結果は全員の画面に届く
export function GameCard({ game, names, onAction }: Props) {
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
  onAction: (action: string, extra?: Record<string, unknown>) => void;
};

function TicTacToe({ game, nameOf, canPlay, onAction }: Sub) {
  const t = game.tictactoe!;
  const mark = (symbol: "X" | "O") => (symbol === "X" ? "×" : "○");
  const mySymbol = game.me === t.symbols.X ? "X" : game.me === t.symbols.O ? "O" : null;
  const myTurn = canPlay && game.status === "playing" && mySymbol !== null && t.turn === mySymbol;
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
            disabled={!myTurn || Boolean(cell)}
            onClick={() => onAction("move", { index: i })}
            aria-label={`${i + 1}番のマス`}
          >
            {cell ? mark(cell as "X" | "O") : ""}
          </button>
        ))}
      </div>
      <p className="game-result">{message}</p>
    </div>
  );
}

function Quiz({ game, nameOf, canPlay, onAction }: Sub) {
  const q = game.quiz!;
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
        <p className="game-meta">第{j.round}回の結果</p>
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
      <p className="game-meta">第{j.round}回　残り{j.alive.length}人</p>
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
