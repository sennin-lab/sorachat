import { useCallback, useEffect, useState } from "react";
import { ApiError, api, post } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Page } from "./Page";
import { SOLO_GAME_VIEWS, type SoloGameId } from "./SoloGames";
import "./senningames.css";

// senningames（/senningames）。1人で遊んでポイントをためる。200pt たまったら、仙人アカウントのポイントへ出金できる。

type GameInfo = {
  id: SoloGameId;
  label: string;
  description: string;
  unit: string;
  pointsPerUnit: number;
  maxPerRound: number;
};
type GamesState = {
  points: number;
  totalPoints: number;
  withdrawnPoints: number;
  linked: boolean;
  withdrawPoints: number;
  canWithdraw: boolean;
  games: GameInfo[];
};
type Flash = { ok: boolean; text: string } | null;
type View =
  | { kind: "home" }
  | { kind: "play"; game: SoloGameId; round: number }
  | { kind: "result"; game: SoloGameId; units: number; added: number | null; error: string | null };

const LINK_HREF = "/api/auth/sennin/link?from=games";
const GAME_MARKS: Record<SoloGameId, string> = { balloon: "🎈", whack: "🔨", stop: "🎯", memory: "🃏" };

const errorOf = (err: unknown) => (err instanceof ApiError ? err.message : "通信に失敗しました。時間をおいてお試しください。");
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const fmt = (n: number) => n.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 出金まであと何pt（小数の切り上げで、足りないのに「出金できます」にならないように）
const remainingTo = (points: number, target: number) => Math.max(0, Math.ceil(Math.round((target - points) * 1000) / 10) / 100);

export function SenningamesPage({ flash, onBack }: { flash?: Flash; onBack: () => void }) {
  const [state, setState] = useState<GamesState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Flash>(flash ?? null);
  const [view, setView] = useState<View>({ kind: "home" });

  // 出金の確認（同じ出金IDで押し直すと、二重には出金されない）
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawId, setWithdrawId] = useState(newId);

  const load = useCallback(() => {
    setLoadError("");
    api<GamesState & { ok: boolean }>("/api/senningames/state")
      .then((data) => setState(data))
      .catch((err) => setLoadError(errorOf(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (flash) setNotice(flash);
  }, [flash]);

  // ラウンドの結果を加算する。画面を戻ったあとでも加算は行う（結果の表示は、まだそのゲームを見ているときだけ）
  const report = (game: SoloGameId, units: number) => {
    if (units <= 0) {
      setView((v) => (v.kind === "play" && v.game === game ? { kind: "result", game, units: 0, added: 0, error: null } : v));
      return;
    }
    api<GamesState & { ok: boolean; added: number }>("/api/senningames/reward", post({ game, units }))
      .then((data) => {
        setState(data);
        setView((v) => (v.kind === "play" && v.game === game ? { kind: "result", game, units, added: data.added, error: null } : v));
      })
      .catch((err) => {
        setView((v) => (v.kind === "play" && v.game === game ? { kind: "result", game, units, added: null, error: errorOf(err) } : v));
      });
  };

  const withdraw = async () => {
    setWithdrawing(true);
    try {
      const data = await api<GamesState & { ok: boolean; withdrawn: number }>("/api/senningames/withdraw", post({ requestId: withdrawId }));
      setState(data);
      setNotice({ ok: true, text: `${data.withdrawn}pt を仙人アカウントのポイントに出金しました。` });
      setWithdrawId(newId());
      setConfirmOpen(false);
    } catch (err) {
      setNotice({ ok: false, text: errorOf(err) });
      // 入ったか分からないとき（502・通信エラー）は同じ出金IDのまま押し直せるようにする。確実に失敗したときは、次は新しい出金として扱う
      const unsure = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
      if (!unsure) setWithdrawId(newId());
      setConfirmOpen(false);
      load();
    } finally {
      setWithdrawing(false);
    }
  };

  const back = () => {
    if (view.kind === "home") onBack();
    else setView({ kind: "home" });
  };

  const title = view.kind === "home" ? "senningames" : view.kind === "play" ? "遊ぶ" : "結果";

  return (
    <Page title={title} onBack={back}>
      <div className="sg-page" key={view.kind === "play" ? `play-${view.game}-${view.round}` : view.kind}>
        {view.kind === "home" && (
          <HomeView
            state={state}
            loadError={loadError}
            notice={notice}
            onRetry={load}
            onPlay={(game) => setView({ kind: "play", game, round: 0 })}
            onWithdraw={() => setConfirmOpen(true)}
          />
        )}

        {view.kind === "play" && state && (
          <PlayView
            game={view.game}
            state={state}
            round={view.round}
            onEnd={(units) => report(view.game, units)}
          />
        )}

        {view.kind === "result" && state && (
          <ResultView
            result={view}
            state={state}
            onAgain={() => setView({ kind: "play", game: view.game, round: Date.now() })}
            onHome={() => setView({ kind: "home" })}
          />
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="出金の確認"
          message={`仙人アカウントのポイントを ${state?.withdrawPoints ?? 200}pt 増やします。senningames の残高は ${state?.withdrawPoints ?? 200}pt 減ります。取り消しはできません。`}
          confirmLabel="出金する"
          busy={withdrawing}
          onConfirm={() => void withdraw()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </Page>
  );
}

// ---- ホーム（残高・出金・ゲーム一覧） ----

function HomeView({
  state,
  loadError,
  notice,
  onRetry,
  onPlay,
  onWithdraw
}: {
  state: GamesState | null;
  loadError: string;
  notice: Flash;
  onRetry: () => void;
  onPlay: (game: SoloGameId) => void;
  onWithdraw: () => void;
}) {
  if (loadError) {
    return (
      <div className="sg-empty">
        <p className="pp-error">{loadError}</p>
        <button type="button" className="sg-secondary" onClick={onRetry}>
          もう一度
        </button>
      </div>
    );
  }
  if (!state) return <p className="pp-hint sg-loading">読み込み中…</p>;

  const target = state.withdrawPoints;
  const ratio = Math.min(state.points / target, 1);
  const left = remainingTo(state.points, target);

  return (
    <>
      {notice && (
        <p className={`pp-notice sg-notice ${notice.ok ? "is-ok" : "is-ng"}`} role="status">
          {notice.text}
        </p>
      )}

      <section className="sg-hero" aria-label="残高">
        <span className="sg-hero-orb" aria-hidden="true" />
        <span className="sg-hero-label">たまったポイント</span>
        <strong key={state.points.toFixed(2)} className="sg-hero-value">
          {fmt(state.points)}
          <small> pt</small>
        </strong>
        <div className="sg-meter" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(state.points, target)}>
          <i style={{ transform: `scaleX(${ratio})` }} />
        </div>
        <span className="sg-hero-sub">
          {left > 0 ? `出金まであと ${fmt(left)} pt` : `${target}pt たまりました。出金できます`}
        </span>
        <div className="sg-hero-stats">
          <span>
            累計 <b>{fmt(state.totalPoints)}</b> pt
          </span>
          <span>
            出金済み <b>{fmt(state.withdrawnPoints)}</b> pt
          </span>
        </div>
        {state.linked ? (
          <button type="button" className="sg-withdraw" disabled={!state.canWithdraw} onClick={onWithdraw}>
            <Icon name="wallet" size={18} />
            {target}pt を仙人アカウントへ出金
          </button>
        ) : (
          <a className="sg-withdraw sg-withdraw-link" href={LINK_HREF}>
            仙人アカウントと連携すると出金できます
          </a>
        )}
      </section>

      <section className="sg-section" aria-label="ゲーム">
        <h2>ゲーム</h2>
        <p className="pp-hint">1ラウンドは30秒。「やめる」か時間切れで、そこまでの分が加算されます。</p>
        <ul className="sg-grid">
          {state.games.map((game, index) => (
            <li key={game.id} className="sg-card-wrap" style={{ animationDelay: `${index * 70}ms` }}>
              <button type="button" className="sg-game" onClick={() => onPlay(game.id)}>
                <span className="sg-game-mark" aria-hidden="true">
                  {GAME_MARKS[game.id]}
                </span>
                <span className="sg-game-name">{game.label}</span>
                <span className="sg-game-desc">{game.description}</span>
                <span className="sg-game-rate">
                  1{game.unit} = +{game.pointsPerUnit.toFixed(2)} pt
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

// ---- 遊ぶ ----

function PlayView({
  game,
  state,
  round,
  onEnd
}: {
  game: SoloGameId;
  state: GamesState;
  round: number;
  onEnd: (units: number) => void;
}) {
  const info = state.games.find((g) => g.id === game);
  const Game = SOLO_GAME_VIEWS[game];
  if (!info) return null;
  return (
    <div className="sg-play" data-round={round}>
      <Game pointsPerUnit={info.pointsPerUnit} unit={info.unit} onEnd={onEnd} />
    </div>
  );
}

// ---- 結果 ----

function ResultView({
  result,
  state,
  onAgain,
  onHome
}: {
  result: { game: SoloGameId; units: number; added: number | null; error: string | null };
  state: GamesState;
  onAgain: () => void;
  onHome: () => void;
}) {
  const info = state.games.find((g) => g.id === result.game);
  const pending = result.added === null && result.error === null;
  return (
    <div className="sg-result">
      <span className={`sg-result-icon ${result.error ? "is-ng" : "is-ok"}`} aria-hidden="true">
        <Icon name={result.error ? "close" : "check"} size={40} />
      </span>
      <h2>{info?.label ?? "ゲーム"}</h2>
      {pending && <p className="pp-hint pp-center">加算しています…</p>}
      {result.added !== null && (
        <>
          <p className="sg-result-pt">+{fmt(result.added)} pt</p>
          <p className="pp-hint pp-center">
            {result.units}
            {info?.unit ?? ""} 達成。今の残高は {fmt(state.points)} pt です。
          </p>
        </>
      )}
      {result.error && (
        <p className="pp-error pp-center" role="alert">
          {result.error}
        </p>
      )}
      <div className="sg-result-actions">
        <button type="button" className="sg-secondary" onClick={onHome}>
          ゲーム一覧
        </button>
        <button type="button" className="sg-primary" onClick={onAgain} disabled={pending}>
          もう一回遊ぶ
        </button>
      </div>
    </div>
  );
}
