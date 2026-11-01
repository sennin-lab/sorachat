import { Icon } from "./Icon";
import { useExitClose } from "./useExitClose";
import type { GameKind } from "./types";

const GAMES: { kind: GameKind; title: string; text: string }[] = [
  { kind: "tictactoe", title: "三目並べ", text: "2人対戦。先に3つ並べた人の勝ち" },
  { kind: "quiz", title: "早押しクイズ", text: "2〜8人。修学旅行の問題を早押しで答える（5問）" },
  { kind: "janken", title: "じゃんけん大会", text: "2〜10人。負けた人が抜けていき、最後の1人が優勝" },
  { kind: "guess", title: "数当て", text: "2〜10人。1〜100の秘密の数字を、ヒントを頼りに当てる" }
];

// 「＋」→「ミニゲーム」で開く。ゲームを選ぶとトークに募集が出る
export function GameSheet({ onPick, onClose }: { onPick: (kind: GameKind) => void; onClose: () => void }) {
  const { closing, close } = useExitClose(onClose);
  return (
    <div className={`sheet-backdrop${closing ? " is-closing" : ""}`} onClick={() => close()}>
      <div className={`sheet game-sheet${closing ? " is-closing" : ""}`} role="dialog" aria-label="ミニゲーム" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title-row">
          <span />
          <strong>ミニゲーム</strong>
          <button type="button" className="icon-btn" onClick={() => close()} aria-label="閉じる">
            <Icon name="close" size={22} />
          </button>
        </div>
        <ul className="game-list">
          {GAMES.map((game) => (
            <li key={game.kind}>
              <button type="button" onClick={() => onPick(game.kind)}>
                <span className="game-list-title">{game.title}</span>
                <small>{game.text}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
