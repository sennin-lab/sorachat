import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./Icon";
import { useExitClose } from "./useExitClose";
import type { QuizPackSummary, QuizSourceChoice } from "./types";

// 募集を出す前に、クイズの出し方を選ぶ：買った問題集か、senninaiが作る問題（ジャンルは任意）
export function QuizSourceSheet({ onConfirm, onClose }: { onConfirm: (source: QuizSourceChoice) => void; onClose: () => void }) {
  const { closing, close } = useExitClose(onClose);
  const [mode, setMode] = useState<"ai" | "pack">("ai");
  const [packs, setPacks] = useState<QuizPackSummary[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [packId, setPackId] = useState<string | null>(null);
  const [genre, setGenre] = useState("");

  useEffect(() => {
    api<QuizPackSummary[]>("/api/dm/quiz-packs")
      .then((list) => setPacks(list))
      .catch(() => setLoadError("購入したクイズを読み込めませんでした。"));
  }, []);

  const canStart = mode === "ai" || packId !== null;

  const submit = () => {
    if (mode === "pack" && packId) onConfirm({ type: "pack", workId: packId });
    else if (mode === "ai") onConfirm({ type: "ai", genre: genre.trim() });
  };

  return (
    <div className={`sheet-backdrop${closing ? " is-closing" : ""}`} onClick={() => close()}>
      <div className={`sheet quiz-source-sheet${closing ? " is-closing" : ""}`} role="dialog" aria-label="クイズの問題" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title-row">
          <span />
          <strong>クイズの問題</strong>
          <button type="button" className="icon-btn" onClick={() => close()} aria-label="閉じる">
            <Icon name="close" size={22} />
          </button>
        </div>

        <div className="qs-modes" role="radiogroup" aria-label="問題の出し方">
          <button type="button" role="radio" aria-checked={mode === "ai"} className={`qs-mode ${mode === "ai" ? "on" : ""}`} onClick={() => setMode("ai")}>
            <Icon name="star" size={20} />
            <span className="qs-mode-title">senninaiが作る</span>
            <small>ジャンルを入力すると、その場でAIが問題を作ります</small>
          </button>
          <button type="button" role="radio" aria-checked={mode === "pack"} className={`qs-mode ${mode === "pack" ? "on" : ""}`} onClick={() => setMode("pack")}>
            <Icon name="shop" size={20} />
            <span className="qs-mode-title">購入したクイズ</span>
            <small>仙人ストアで買った問題集から出題します</small>
          </button>
        </div>

        {mode === "ai" && (
          <label className="qs-field">
            <span>ジャンル（任意）</span>
            <input
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              maxLength={GENRE_LIMIT}
              placeholder="例：日本の歴史、動物、映画（空欄なら色々な分野から）"
            />
            <small className="qs-count">{genre.length}/{GENRE_LIMIT}</small>
          </label>
        )}

        {mode === "pack" && (
          <div className="qs-pack-list">
            {loadError && <p className="notice error center">{loadError}</p>}
            {!loadError && packs === null && <p className="notice center">読み込み中…</p>}
            {packs && packs.length === 0 && (
              <p className="notice center">購入したクイズがありません。仙人ストアで問題集を買うと、ここから出題できます。</p>
            )}
            {packs?.map((pack) => (
              <button
                key={pack.id}
                type="button"
                role="radio"
                aria-checked={packId === pack.id}
                className={`qs-pack ${packId === pack.id ? "on" : ""}`}
                onClick={() => setPackId(pack.id)}
              >
                <span className="qs-pack-name">{pack.name}</span>
                <span className="qs-pack-count">全{pack.count}問</span>
                {packId === pack.id && <Icon name="check" size={18} className="qs-pack-check" />}
              </button>
            ))}
          </div>
        )}

        <button type="button" className="btn-primary qs-submit" disabled={!canStart} onClick={submit}>
          募集を出す
        </button>
      </div>
    </div>
  );
}

const GENRE_LIMIT = 30;
