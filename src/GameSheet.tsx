import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./Icon";
import { useExitClose } from "./useExitClose";
import type { GameKind, StoreView } from "./types";

const GAMES: { kind: GameKind; title: string; text: string }[] = [
  { kind: "tictactoe", title: "三目並べ", text: "2人対戦。先に3つ並べた人の勝ち" },
  { kind: "quiz", title: "早押しクイズ", text: "2〜8人。senninaiが毎回作る問題を早押しで答える（5問）" },
  { kind: "janken", title: "じゃんけん大会", text: "2〜10人。負けた人が抜けていき、最後の1人が優勝" },
  { kind: "guess", title: "数当て", text: "2〜10人。1〜100の秘密の数字を、ヒントを頼りに当てる" },
  { kind: "tap", title: "連打バトル", text: "2〜10人。10秒間に一番多くタップした人の勝ち" },
  { kind: "reflex", title: "反射神経バトル", text: "2〜8人。GOの合図で一番早く押した人が1点。3ラウンドの合計点で勝負" }
];

// 「＋」→「ミニゲーム」で開く。ゲームを選ぶとトークに募集が出る
// 拡張機能として売っているゲームは、買っていないと鍵が付く（仙人ストアで購入できる）
export function GameSheet({ onPick, onClose }: { onPick: (kind: GameKind) => void; onClose: () => void }) {
  const { closing, close } = useExitClose(onClose);
  // 買っていないゲームの種類
  const [locked, setLocked] = useState<Set<GameKind>>(() => new Set());
  const [note, setNote] = useState("");

  useEffect(() => {
    api<StoreView>("/api/store")
      .then((view) => {
        const next = new Set<GameKind>();
        for (const item of view.items) {
          if (item.kind === "extension" && !item.owned && item.feature?.startsWith("game:")) {
            next.add(item.feature.slice("game:".length) as GameKind);
          }
        }
        setLocked(next);
      })
      .catch(() => undefined);
  }, []);

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
          {GAMES.map((game) => {
            const isLocked = locked.has(game.kind);
            return (
              <li key={game.kind}>
                <button
                  type="button"
                  className={isLocked ? "is-locked" : undefined}
                  onClick={() => {
                    if (isLocked) {
                      setNote("このゲームは仙人ストアの拡張機能です。購入すると遊べます。");
                      return;
                    }
                    onPick(game.kind);
                  }}
                >
                  <span className="game-list-title">
                    {game.title}
                    {isLocked && (
                      <span className="game-lock" aria-label="ストアで購入">
                        <Icon name="lock" size={13} />
                      </span>
                    )}
                  </span>
                  <small>{game.text}</small>
                </button>
              </li>
            );
          })}
        </ul>
        {note && <p className="game-note" role="status">{note}</p>}
      </div>
    </div>
  );
}
