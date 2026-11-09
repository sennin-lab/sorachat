import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";

// senningames の4つのゲーム。1ラウンドは30秒。
// 遊んだ数（風船・もぐら・成功・組）は、ラウンドが終わったときにだけ onEnd で親へ渡す。
// ポイントの計算は、サーバーがやる（画面では数だけを数える）。

export const ROUND_MS = 30_000;
export type SoloGameId = "balloon" | "whack" | "stop" | "memory";

// ---- ラウンドの枠（残り時間・今回の数・やめるボタン） ----

function RoundFrame({
  score,
  unit,
  pointsPerUnit,
  onFinish,
  children
}: {
  score: number;
  unit: string;
  pointsPerUnit: number;
  onFinish: () => void;
  children: ReactNode;
}) {
  const [left, setLeft] = useState(ROUND_MS);
  const doneRef = useRef(false);
  // 最新の onFinish（最新の数を含む）を、タイマーから呼べるように覚えておく
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    finishRef.current();
  }, []);

  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => {
      const rest = Math.max(0, ROUND_MS - (performance.now() - started));
      setLeft(rest);
      if (rest <= 0) {
        window.clearInterval(id);
        finish();
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [finish]);

  // 途中で画面を戻ったときも、そこまでの数は加算する（取りこぼさないように）
  const scoreRef = useRef(score);
  scoreRef.current = score;
  useEffect(
    () => () => {
      if (scoreRef.current > 0) finish();
    },
    [finish]
  );

  const earned = score * pointsPerUnit;
  return (
    <div className="sg-round">
      <div className="sg-hud">
        <div className="sg-hud-main">
          <span className="sg-hud-label">今回</span>
          <strong key={score} className="sg-score">
            {score}
            <small>{unit}</small>
          </strong>
          <span className="sg-hud-pt">+{earned.toFixed(2)} pt</span>
        </div>
        <span className={`sg-time${left <= 5000 ? " is-hurry" : ""}`}>{Math.ceil(left / 1000)}</span>
        <button type="button" className="sg-stop" onClick={finish}>
          やめる
        </button>
      </div>
      <div className="sg-timebar" aria-hidden="true">
        <i style={{ transform: `scaleX(${left / ROUND_MS})` }} />
      </div>
      {children}
    </div>
  );
}

// ---- 風船割り：風船が下から上へ浮く。タップで割る ----

type Balloon = { id: number; x: number; hue: number; dur: number; popped: boolean };

function BalloonGame({ pointsPerUnit, unit, onEnd }: GameProps) {
  const [balloons, setBalloons] = useState<Balloon[]>([]);
  const [score, setScore] = useState(0);
  const nextId = useRef(0);
  const scoreRef = useRef(0);

  useEffect(() => {
    const spawn = () => {
      const id = nextId.current++;
      const balloon: Balloon = {
        id,
        x: 6 + Math.random() * 88,
        hue: Math.floor(Math.random() * 360),
        dur: 4200 + Math.random() * 2400,
        popped: false
      };
      setBalloons((list) => [...list.filter((b) => !b.popped).slice(-24), balloon]);
      window.setTimeout(() => setBalloons((list) => list.filter((b) => b.id !== id)), balloon.dur + 50);
    };
    spawn();
    const id = window.setInterval(spawn, 650);
    return () => window.clearInterval(id);
  }, []);

  const pop = (id: number) => {
    setBalloons((list) => list.map((b) => (b.id === id && !b.popped ? { ...b, popped: true } : b)));
    scoreRef.current += 1;
    setScore(scoreRef.current);
    window.setTimeout(() => setBalloons((list) => list.filter((b) => b.id !== id)), 320);
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} onFinish={() => onEnd(scoreRef.current)}>
      <div className="sg-field sg-sky" aria-label="風船のエリア">
        {balloons.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`sg-balloon${b.popped ? " is-popped" : ""}`}
            style={{ left: `${b.x}%`, "--hue": b.hue, animationDuration: `${b.dur}ms` } as CSSProperties}
            onPointerDown={(e) => {
              e.preventDefault();
              pop(b.id);
            }}
            aria-label="風船を割る"
          >
            <span className="sg-balloon-body" />
            <span className="sg-balloon-string" />
          </button>
        ))}
        <span className="sg-hint sg-hint-float">ふくらんだ風船をタップ！</span>
      </div>
    </RoundFrame>
  );
}

// ---- もぐらたたき：3x3 の穴から、もぐらが顔を出す ----

function WhackGame({ pointsPerUnit, unit, onEnd }: GameProps) {
  const [mole, setMole] = useState<{ hole: number; key: number; up: boolean } | null>(null);
  const [score, setScore] = useState(0);
  const [flash, setFlash] = useState<number | null>(null);
  const scoreRef = useRef(0);
  const keyRef = useRef(0);

  useEffect(() => {
    const timers: number[] = [];
    const show = () => {
      const key = ++keyRef.current;
      const hole = Math.floor(Math.random() * 9);
      setMole({ hole, key, up: true });
      timers.push(
        window.setTimeout(() => {
          setMole((m) => (m && m.key === key ? { ...m, up: false } : m));
        }, 850)
      );
    };
    show();
    const id = window.setInterval(show, 950);
    return () => {
      window.clearInterval(id);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const hit = (hole: number) => {
    if (!mole || !mole.up || mole.hole !== hole) return;
    scoreRef.current += 1;
    setScore(scoreRef.current);
    setFlash(hole);
    setMole({ ...mole, up: false });
    window.setTimeout(() => setFlash(null), 260);
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} onFinish={() => onEnd(scoreRef.current)}>
      <div className="sg-field sg-holes" role="group" aria-label="もぐらの穴">
        {Array.from({ length: 9 }, (_, hole) => {
          const up = mole?.hole === hole && mole.up;
          return (
            <button
              key={hole}
              type="button"
              className={`sg-hole${flash === hole ? " is-hit" : ""}`}
              onPointerDown={(e) => {
                e.preventDefault();
                hit(hole);
              }}
              aria-label={`穴${hole + 1}`}
            >
              <span className="sg-dirt" aria-hidden="true" />
              {up && mole && (
                <span key={mole.key} className="sg-mole" aria-hidden="true">
                  <span className="sg-mole-face">ᐡ•ㅅ•ᐡ</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </RoundFrame>
  );
}

// ---- ストップ：動くバーを、的の中で止める ----

const STOP_TRACK = 100;

function StopGame({ pointsPerUnit, unit, onEnd }: GameProps) {
  const [score, setScore] = useState(0);
  const [target, setTarget] = useState({ center: 50, width: 14 });
  const [verdict, setVerdict] = useState<"ok" | "miss" | null>(null);
  const [pos, setPos] = useState(0);
  const scoreRef = useRef(0);
  // 位置は止めるまで動き続ける。速さは成功するほど上がる（最も速くても 0.7 秒で往復）
  const startRef = useRef(performance.now());
  const posRef = useRef(0);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const period = Math.max(700, 1600 - scoreRef.current * 70);
      const phase = ((performance.now() - startRef.current) % period) / period;
      const next = (phase < 0.5 ? phase * 2 : 2 - phase * 2) * STOP_TRACK;
      posRef.current = next;
      setPos(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const stop = () => {
    const inside = Math.abs(posRef.current - target.center) <= target.width / 2;
    if (inside) {
      scoreRef.current += 1;
      setScore(scoreRef.current);
    }
    setVerdict(inside ? "ok" : "miss");
    window.setTimeout(() => setVerdict(null), 420);
    // 次の的は、ばらばらの場所に出す（同じ所ばかりにならないように）
    setTarget({ center: 12 + Math.random() * 76, width: Math.max(7, 16 - scoreRef.current * 0.3) });
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} onFinish={() => onEnd(scoreRef.current)}>
      <button type="button" className={`sg-field sg-stopfield${verdict ? ` is-${verdict}` : ""}`} onPointerDown={stop} aria-label="タップしてバーを止める">
        <span className="sg-track">
          <span className="sg-zone" style={{ left: `${target.center - target.width / 2}%`, width: `${target.width}%` }} />
          <span className="sg-marker" style={{ left: `${pos}%` }} />
        </span>
        <span className="sg-hint">タップで止める</span>
        {verdict && <span className={`sg-verdict is-${verdict}`}>{verdict === "ok" ? "ナイス！" : "おしい…"}</span>}
      </button>
    </RoundFrame>
  );
}

// ---- 神経衰弱：同じ絵柄のカードを2枚ずつそろえる ----

const SYMBOLS = ["★", "♥", "♣", "♦", "●", "▲", "■", "✿"];

function shuffledCards() {
  const deck = [...SYMBOLS, ...SYMBOLS].map((symbol, id) => ({ id, symbol, open: false, matched: false }));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

type Card = { id: number; symbol: string; open: boolean; matched: boolean };

function MemoryGame({ pointsPerUnit, unit, onEnd }: GameProps) {
  const [cards, setCards] = useState<Card[]>(shuffledCards);
  const [score, setScore] = useState(0);
  const [picked, setPicked] = useState<number[]>([]);
  const scoreRef = useRef(0);
  const busyRef = useRef(false);

  const flip = (index: number) => {
    if (busyRef.current) return;
    const card = cards[index];
    if (!card || card.open || card.matched) return;
    const next = cards.map((c, i) => (i === index ? { ...c, open: true } : c));
    const pair = [...picked, index];
    setCards(next);
    if (pair.length < 2) {
      setPicked(pair);
      return;
    }
    // 2枚目をめくったら判定する
    busyRef.current = true;
    setPicked([]);
    const [a, b] = pair;
    if (next[a].symbol === next[b].symbol) {
      scoreRef.current += 1;
      setScore(scoreRef.current);
      window.setTimeout(() => {
        setCards((list) => {
          const done = list.map((c, i) => (i === a || i === b ? { ...c, matched: true } : c));
          // 全部そろったら、切らずに次の札を並べる（時間が終わるまで続けられる）
          return done.every((c) => c.matched) ? shuffledCards() : done;
        });
        busyRef.current = false;
      }, 380);
    } else {
      window.setTimeout(() => {
        setCards((list) => list.map((c, i) => (i === a || i === b ? { ...c, open: false } : c)));
        busyRef.current = false;
      }, 800);
    }
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} onFinish={() => onEnd(scoreRef.current)}>
      <div className="sg-field sg-cards" role="group" aria-label="カード">
        {cards.map((card, index) => (
          <button
            key={card.id}
            type="button"
            className={`sg-card${card.open || card.matched ? " is-open" : ""}${card.matched ? " is-matched" : ""}`}
            onClick={() => flip(index)}
            aria-label={card.open || card.matched ? card.symbol : "裏向きのカード"}
          >
            <span className="sg-card-inner">
              <span className="sg-card-back" aria-hidden="true">
                ?
              </span>
              <span className="sg-card-face" aria-hidden="true">
                {card.symbol}
              </span>
            </span>
          </button>
        ))}
      </div>
    </RoundFrame>
  );
}

// ---- 外から見える部品 ----

type GameProps = { pointsPerUnit: number; unit: string; onEnd: (units: number) => void };

export const SOLO_GAME_VIEWS: Record<SoloGameId, (props: GameProps) => ReactElement> = {
  balloon: BalloonGame,
  whack: WhackGame,
  stop: StopGame,
  memory: MemoryGame
};
