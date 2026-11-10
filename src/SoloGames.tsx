import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";

// senningames のゲーム。1ラウンドは30秒。
// 遊んだ数（風船・もぐら・成功・組・音符・星）は、ラウンドが終わったときにだけ onEnd で親へ渡す。
// ポイントの計算は、サーバーがやる（画面では数だけを数える）。コンボは画面の表示だけで、ポイントには関係しない。

export const ROUND_MS = 30_000;
export type SoloGameId = "balloon" | "balloon_hard" | "whack" | "stop" | "memory" | "rhythm" | "numbers" | "catch";

// ---- 連続の成功（コンボ）。3回からは画面に出す。失敗したら止まる ----

function useCombo() {
  const [combo, setCombo] = useState(0);
  const ref = useRef(0);
  const hit = useCallback(() => {
    ref.current += 1;
    setCombo(ref.current);
  }, []);
  const miss = useCallback(() => {
    ref.current = 0;
    setCombo(0);
  }, []);
  return { combo, hit, miss };
}

// ---- ラウンドの枠（残り時間・今回の数・コンボ・やめるボタン） ----

function RoundFrame({
  score,
  unit,
  pointsPerUnit,
  combo,
  onFinish,
  children
}: {
  score: number;
  unit: string;
  pointsPerUnit: number;
  combo: number;
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
          <strong key={`score-${score}`} className="sg-score">
            {score}
            <small>{unit}</small>
          </strong>
          <span className="sg-hud-pt">+{earned.toFixed(2)} pt</span>
          {combo >= 3 && (
            <span key={`combo-${combo}`} className="sg-combo">
              {combo} コンボ
            </span>
          )}
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

// ---- 風船割り（ふつう・ハード）：風船が下から上へ浮く。タップで割る。ハードは小さく速い ----

type Balloon = { id: number; x: number; hue: number; dur: number; popped: boolean };

function BalloonGame({ pointsPerUnit, unit, onEnd, hard = false }: GameProps & { hard?: boolean }) {
  const [balloons, setBalloons] = useState<Balloon[]>([]);
  const [score, setScore] = useState(0);
  const nextId = useRef(0);
  const scoreRef = useRef(0);
  const poppedIds = useRef(new Set<number>());
  const { combo, hit, miss } = useCombo();

  useEffect(() => {
    const spawn = () => {
      const id = nextId.current++;
      const balloon: Balloon = {
        id,
        x: 6 + Math.random() * 88,
        hue: Math.floor(Math.random() * 360),
        // ハードは、上がるのが速い（消えるまでが短い）
        dur: hard ? 2300 + Math.random() * 1000 : 4200 + Math.random() * 2400,
        popped: false
      };
      setBalloons((list) => [...list.filter((b) => !b.popped).slice(-(hard ? 30 : 24)), balloon]);
      window.setTimeout(() => {
        // 割らずに消えた風船は、コンボを止める
        if (!poppedIds.current.has(id)) miss();
        poppedIds.current.delete(id);
        setBalloons((list) => list.filter((b) => b.id !== id));
      }, balloon.dur + 50);
    };
    spawn();
    const timer = window.setInterval(spawn, hard ? 380 : 650);
    return () => window.clearInterval(timer);
  }, [hard, miss]);

  const pop = (id: number) => {
    if (poppedIds.current.has(id)) return;
    poppedIds.current.add(id);
    setBalloons((list) => list.map((b) => (b.id === id ? { ...b, popped: true } : b)));
    scoreRef.current += 1;
    setScore(scoreRef.current);
    hit();
    window.setTimeout(() => setBalloons((list) => list.filter((b) => b.id !== id)), 320);
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} combo={combo} onFinish={() => onEnd(scoreRef.current)}>
      <div className="sg-field sg-sky" aria-label="風船のエリア">
        {balloons.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`sg-balloon${b.popped ? " is-popped" : ""}${hard ? " is-hard" : ""}`}
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
        <span className="sg-hint sg-hint-float">{hard ? "速い！ 小さい風船をタップ" : "ふくらんだ風船をタップ！"}</span>
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
  const { combo, hit, miss } = useCombo();

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

  const tapHole = (hole: number) => {
    if (!mole || !mole.up || mole.hole !== hole) {
      // 空いている穴を叩いたら、コンボは止まる
      miss();
      return;
    }
    scoreRef.current += 1;
    setScore(scoreRef.current);
    hit();
    setFlash(hole);
    setMole({ ...mole, up: false });
    window.setTimeout(() => setFlash(null), 260);
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} combo={combo} onFinish={() => onEnd(scoreRef.current)}>
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
                tapHole(hole);
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
  const { combo, hit, miss } = useCombo();
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
      hit();
    } else {
      miss();
    }
    setVerdict(inside ? "ok" : "miss");
    window.setTimeout(() => setVerdict(null), 420);
    // 次の的は、ばらばらの場所に出す（同じ所ばかりにならないように）
    setTarget({ center: 12 + Math.random() * 76, width: Math.max(7, 16 - scoreRef.current * 0.3) });
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} combo={combo} onFinish={() => onEnd(scoreRef.current)}>
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
  const { combo, hit, miss } = useCombo();

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
      hit();
      window.setTimeout(() => {
        setCards((list) => {
          const done = list.map((c, i) => (i === a || i === b ? { ...c, matched: true } : c));
          // 全部そろったら、切らずに次の札を並べる（時間が終わるまで続けられる）
          return done.every((c) => c.matched) ? shuffledCards() : done;
        });
        busyRef.current = false;
      }, 380);
    } else {
      miss();
      window.setTimeout(() => {
        setCards((list) => list.map((c, i) => (i === a || i === b ? { ...c, open: false } : c)));
        busyRef.current = false;
      }, 800);
    }
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} combo={combo} onFinish={() => onEnd(scoreRef.current)}>
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

// ---- リズムタップ：4つのレーンに落ちてくる音符を、線のところでタップする ----

const LANES = 4;
// 線（タップする場所）の範囲。画面の高さに対する %
const LINE_TOP = 82;
const LINE_BOTTOM = 96;
type Note = { id: number; lane: number; y: number; done: boolean };

function RhythmGame({ pointsPerUnit, unit, onEnd }: GameProps) {
  const [score, setScore] = useState(0);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [flash, setFlash] = useState<{ lane: number; kind: "ok" | "miss"; key: number } | null>(null);
  const notesRef = useRef<Note[]>([]);
  const nextId = useRef(0);
  const scoreRef = useRef(0);
  const { combo, hit, miss } = useCombo();

  useEffect(() => {
    // 落ちる速さは、合わせるほど少しずつ上がる
    const tick = window.setInterval(() => {
      const speed = 1.7 + Math.min(scoreRef.current, 40) * 0.03;
      let missed = false;
      for (const n of notesRef.current) {
        if (n.done) continue;
        n.y += speed;
        if (n.y > LINE_BOTTOM) {
          n.done = true;
          missed = true;
        }
      }
      if (missed) miss();
      // 押した音符も落ちきった音符も、この時点で一覧から外す
      notesRef.current = notesRef.current.filter((n) => !n.done);
      redraw();
    }, 50);
    const spawn = window.setInterval(() => {
      notesRef.current.push({ id: nextId.current++, lane: Math.floor(Math.random() * LANES), y: -4, done: false });
    }, 480);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(spawn);
    };
  }, [miss]);

  const tapLane = (lane: number) => {
    const target = notesRef.current.find((n) => !n.done && n.lane === lane && n.y >= LINE_TOP && n.y <= LINE_BOTTOM);
    if (!target) {
      setFlash({ lane, kind: "miss", key: Date.now() });
      miss();
      return;
    }
    target.done = true;
    scoreRef.current += 1;
    setScore(scoreRef.current);
    hit();
    setFlash({ lane, kind: "ok", key: Date.now() });
    redraw();
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} combo={combo} onFinish={() => onEnd(scoreRef.current)}>
      <div className="sg-field sg-rhythm" aria-label="音符のエリア">
        {notesRef.current
          .filter((n) => !n.done)
          .map((n) => (
            <span key={n.id} className="sg-note" style={{ left: `${n.lane * (100 / LANES) + 6}%`, width: `${100 / LANES - 12}%`, top: `${n.y}%` }} aria-hidden="true" />
          ))}
        <div className="sg-pads" style={{ top: `${LINE_TOP}%` }}>
          {Array.from({ length: LANES }, (_, lane) => (
            <button
              key={lane}
              type="button"
              className="sg-pad"
              onPointerDown={(e) => {
                e.preventDefault();
                tapLane(lane);
              }}
              aria-label={`レーン${lane + 1}`}
            >
              {flash?.lane === lane && <span key={flash.key} className={`sg-pad-fx is-${flash.kind}`} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <span className="sg-hint">線に合わせてタップ</span>
      </div>
    </RoundFrame>
  );
}

// ---- 数字つなぎ：1から順に、4x4 の数字を速くタップする。16個そろえたら1組 ----

const GRID_SIZE = 16;
type NumCell = { n: number; done: boolean };

function freshNumbers(): NumCell[] {
  const values = Array.from({ length: GRID_SIZE }, (_, i) => i + 1);
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values.map((n) => ({ n, done: false }));
}

function NumbersGame({ pointsPerUnit, unit, onEnd }: GameProps) {
  const [cells, setCells] = useState<NumCell[]>(freshNumbers);
  const [next, setNext] = useState(1);
  const [score, setScore] = useState(0);
  const [wrong, setWrong] = useState<{ index: number; key: number } | null>(null);
  const scoreRef = useRef(0);
  const busyRef = useRef(false);
  const { combo, hit, miss } = useCombo();

  const tap = (index: number) => {
    if (busyRef.current) return;
    const cell = cells[index];
    if (!cell || cell.done) return;
    if (cell.n !== next) {
      const key = Date.now();
      setWrong({ index, key });
      window.setTimeout(() => setWrong((w) => (w && w.key === key ? null : w)), 350);
      miss();
      return;
    }
    hit();
    const after = cells.map((c, i) => (i === index ? { ...c, done: true } : c));
    setCells(after);
    if (next === GRID_SIZE) {
      // そろったら、少しの間をおいて次の並びにする
      busyRef.current = true;
      scoreRef.current += 1;
      setScore(scoreRef.current);
      window.setTimeout(() => {
        setCells(freshNumbers());
        setNext(1);
        busyRef.current = false;
      }, 420);
    } else {
      setNext(next + 1);
    }
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} combo={combo} onFinish={() => onEnd(scoreRef.current)}>
      <div className="sg-field sg-numbers" role="group" aria-label="数字のマス">
        <p className="sg-next">
          次は <strong>{next <= GRID_SIZE ? next : "…"}</strong>
        </p>
        <div className="sg-numgrid">
          {cells.map((cell, index) => (
            <button
              key={cell.n}
              type="button"
              className={`sg-num${cell.done ? " is-done" : ""}${wrong?.index === index ? " is-wrong" : ""}`}
              onPointerDown={(e) => {
                e.preventDefault();
                tap(index);
              }}
              aria-label={`${cell.n}`}
            >
              {wrong?.index === index && <span key={wrong.key} className="sg-num-fx" aria-hidden="true" />}
              {cell.done ? "" : cell.n}
            </button>
          ))}
        </div>
      </div>
    </RoundFrame>
  );
}

// ---- 星キャッチ：落ちてくる星をタップ。爆弾は取らない ----

type Falling = { id: number; x: number; dur: number; bomb: boolean; gone: boolean };

function CatchGame({ pointsPerUnit, unit, onEnd }: GameProps) {
  const [items, setItems] = useState<Falling[]>([]);
  const [score, setScore] = useState(0);
  const [boom, setBoom] = useState<{ x: number; key: number } | null>(null);
  const nextId = useRef(0);
  const scoreRef = useRef(0);
  const caughtIds = useRef(new Set<number>());
  const { combo, hit, miss } = useCombo();

  useEffect(() => {
    const spawn = () => {
      const id = nextId.current++;
      // 慣れるほど、落ちるのが速くなる
      const item: Falling = {
        id,
        x: 8 + Math.random() * 84,
        dur: Math.max(1900, 3600 - scoreRef.current * 40) + Math.random() * 700,
        bomb: Math.random() < 0.22,
        gone: false
      };
      setItems((list) => [...list.slice(-30), item]);
      window.setTimeout(() => {
        // 取らずに落ちた星は、コンボを止める（爆弾が落ちるのは、どちらでもよい）
        if (!item.bomb && !caughtIds.current.has(id)) miss();
        caughtIds.current.delete(id);
        setItems((list) => list.filter((i) => i.id !== id));
      }, item.dur + 50);
    };
    spawn();
    const timer = window.setInterval(spawn, 620);
    return () => window.clearInterval(timer);
  }, [miss]);

  const tap = (item: Falling) => {
    if (item.gone || caughtIds.current.has(item.id)) return;
    caughtIds.current.add(item.id);
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, gone: true } : i)));
    if (item.bomb) {
      setBoom({ x: item.x, key: Date.now() });
      miss();
      return;
    }
    scoreRef.current += 1;
    setScore(scoreRef.current);
    hit();
  };

  return (
    <RoundFrame score={score} unit={unit} pointsPerUnit={pointsPerUnit} combo={combo} onFinish={() => onEnd(scoreRef.current)}>
      <div className="sg-field sg-catch" aria-label="星のエリア">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`sg-fall${item.bomb ? " is-bomb" : ""}${item.gone ? " is-gone" : ""}`}
            style={{ left: `${item.x}%`, animationDuration: `${item.dur}ms` }}
            onPointerDown={(e) => {
              e.preventDefault();
              tap(item);
            }}
            aria-label={item.bomb ? "爆弾（取らない）" : "星を取る"}
          >
            {item.bomb ? "💣" : "⭐"}
          </button>
        ))}
        {boom && (
          <span key={boom.key} className="sg-boom" style={{ left: `${boom.x}%` }} aria-hidden="true">
            ばくっ！
          </span>
        )}
        <span className="sg-hint">星だけをタップ（💣 は取らない）</span>
      </div>
    </RoundFrame>
  );
}

// ---- 外から見える部品 ----

type GameProps = { pointsPerUnit: number; unit: string; onEnd: (units: number) => void };

export const SOLO_GAME_VIEWS: Record<SoloGameId, (props: GameProps) => ReactElement> = {
  balloon: (props) => <BalloonGame {...props} />,
  balloon_hard: (props) => <BalloonGame {...props} hard />,
  whack: WhackGame,
  stop: StopGame,
  memory: MemoryGame,
  rhythm: RhythmGame,
  numbers: NumbersGame,
  catch: CatchGame
};
