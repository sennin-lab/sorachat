import { useEffect, useRef, useState, type TouchEvent } from "react";
import { Icon, type IconName } from "./Icon";
import { RobotFace } from "./robot";

// 初めて起動したときに出す、ウェルカムの動きと機能紹介。終わったら二度と自動では出さない
const INTRO_KEY = "sorachat.intro.v1";

export function hasSeenIntro(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    // 保存できない環境では、毎回出すと困るので見たことにする
    return true;
  }
}

export function markIntroSeen() {
  try {
    window.localStorage.setItem(INTRO_KEY, "1");
  } catch {
    // 保存できなくても続ける
  }
}

// 設定の「機能紹介を見る」から使う。次に開いたとき、もう一度紹介を出す
export function resetIntro() {
  try {
    window.localStorage.removeItem(INTRO_KEY);
  } catch {
    // 何もしない
  }
}

type Slide = { icon: IconName | "robot"; title: string; body: string };

const SLIDES: Slide[] = [
  {
    icon: "chat",
    title: "トークで、いつでも話せる",
    body: "1対1もグループも。文字・スタンプ・写真・ファイルを送れます。返信やリアクションも使えます。"
  },
  {
    icon: "users",
    title: "友だちとつながる",
    body: "ユーザー名の検索やQRコードで友だちを追加。プロフィールやノートで近況も伝えられます。"
  },
  {
    icon: "poll",
    title: "LINEのような投票",
    body: "複数選択や匿名投票に対応。投票は全画面で開いて、票の内訳や投票した人を確かめられます。"
  },
  {
    icon: "file",
    title: "PDFもトークの中で開ける",
    body: "届いたPDFやテキストファイルは、タップするとトークを離れずに読めます。"
  },
  {
    icon: "robot",
    title: "senninai（AIチャット）",
    body: "AIに話しかけたり、トークの要約や返信案を頼めます。グループのミニゲームのクイズは、senninaiが毎回作ります。"
  }
];

const SWIPE_PX = 48;

export function Intro({ onDone }: { onDone: () => void }) {
  // welcome → 紹介（スライド）の順に進む
  const [phase, setPhase] = useState<"welcome" | "tour">("welcome");
  const [index, setIndex] = useState(0);
  const touchX = useRef<number | null>(null);
  const last = index === SLIDES.length - 1;

  // ウェルカムの動きは一定時間で紹介に進む（タップでも進める）
  useEffect(() => {
    if (phase !== "welcome") return;
    const id = window.setTimeout(() => setPhase("tour"), 2800);
    return () => window.clearTimeout(id);
  }, [phase]);

  const finish = () => {
    markIntroSeen();
    onDone();
  };

  const next = () => (last ? finish() : setIndex((i) => i + 1));

  const onTouchStart = (e: TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchX.current;
    touchX.current = null;
    const end = e.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    const dx = end - start;
    if (dx <= -SWIPE_PX && index < SLIDES.length - 1) setIndex((i) => i + 1);
    if (dx >= SWIPE_PX && index > 0) setIndex((i) => i - 1);
  };

  if (phase === "welcome") {
    return (
      <div className="intro intro-welcome" onClick={() => setPhase("tour")} role="button" tabIndex={0}>
        <div className="intro-orb intro-orb-a" aria-hidden="true" />
        <div className="intro-orb intro-orb-b" aria-hidden="true" />
        <div className="intro-logo" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="88" height="88">
            <path className="intro-logo-bubble" d="M32 8C17.6 8 6 17.4 6 29c0 6.4 3.4 12.1 8.8 16L12 56l12.2-7.4c2.6.6 5.3.9 7.8.9 14.4 0 26-9.4 26-21S46.4 8 32 8z" />
            <circle className="intro-logo-dot" cx="20" cy="29" r="3.6" />
            <circle className="intro-logo-dot" cx="32" cy="29" r="3.6" />
            <circle className="intro-logo-dot" cx="44" cy="29" r="3.6" />
          </svg>
        </div>
        <h1 className="intro-welcome-title">
          <span>ようこそ</span>
          <span className="intro-welcome-name">SoraChat</span>
        </h1>
        <p className="intro-welcome-sub">話したい人と、つながる場所</p>
        <p className="intro-tap">タップして次へ</p>
        <ul className="intro-particles" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => (
            <li key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 6) * 0.25}s` }} />
          ))}
        </ul>
      </div>
    );
  }

  const slide = SLIDES[index];
  return (
    <div className="intro intro-tour">
      <div className="intro-top">
        <span className="intro-brand">SoraChat</span>
        <button type="button" className="btn-text" onClick={finish}>
          スキップ
        </button>
      </div>

      <div className="intro-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="intro-slide" key={index}>
          <div className="intro-badge">
            {slide.icon === "robot" ? <RobotFace className="intro-robot" /> : <Icon name={slide.icon} size={44} />}
          </div>
          <h2>{slide.title}</h2>
          <p>{slide.body}</p>
        </div>
      </div>

      <div className="intro-foot">
        <div className="intro-dots" role="tablist" aria-label="機能紹介のページ">
          {SLIDES.map((s, i) => (
            <button
              type="button"
              key={s.title}
              className={`intro-dot${i === index ? " on" : ""}`}
              onClick={() => setIndex(i)}
              aria-label={`${i + 1}ページ目`}
              aria-selected={i === index}
              role="tab"
            />
          ))}
        </div>
        <button type="button" className="btn-primary wide intro-next" onClick={next}>
          {last ? "はじめる" : "次へ"}
        </button>
      </div>
    </div>
  );
}
