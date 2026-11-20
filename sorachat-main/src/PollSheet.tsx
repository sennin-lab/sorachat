import { useState } from "react";
import { Icon } from "./Icon";
import { useExitClose } from "./useExitClose";

export type PollDraft = { question: string; options: string[]; multiple: boolean; anonymous: boolean };

const MAX_OPTIONS = 10;

// 「＋」→「投票」で開く全画面の作成画面。質問と選択肢（2〜10個）、複数選択・匿名を決めて送る
export function PollSheet({ onSubmit, onClose }: { onSubmit: (poll: PollDraft) => Promise<void>; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { closing, close } = useExitClose(onClose);

  const cleaned = options.map((o) => o.trim()).filter(Boolean);
  const duplicated = new Set(cleaned).size !== cleaned.length;
  const valid = question.trim().length > 0 && cleaned.length >= 2 && !duplicated;

  const setOption = (index: number, value: string) => setOptions((list) => list.map((o, i) => (i === index ? value : o)));
  const removeOption = (index: number) => setOptions((list) => list.filter((_, i) => i !== index));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({ question: question.trim(), options: cleaned, multiple, anonymous });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "投票を送信できませんでした。");
      setBusy(false);
    }
  };

  return (
    <div className={`poll-screen poll-create${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label="投票を作成">
      <header className="poll-screen-bar">
        <button type="button" className="icon-btn" onClick={() => close()} aria-label="閉じる">
          <Icon name="close" size={22} />
        </button>
        <strong>投票を作成</strong>
        <button type="button" className="btn-small accent" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? "送信中…" : "送信"}
        </button>
      </header>

      <div className="poll-screen-body">
        <div className="poll-form">
          <label className="poll-field">
            <span className="muted small">質問</span>
            <input value={question} maxLength={100} placeholder="例: 今日のランチどこにする？" onChange={(e) => setQuestion(e.target.value)} />
          </label>

          <span className="muted small">選択肢（2〜{MAX_OPTIONS}個）</span>
          {options.map((option, i) => (
            <div className="poll-option-input" key={i}>
              <input value={option} maxLength={60} placeholder={`選択肢 ${i + 1}`} onChange={(e) => setOption(i, e.target.value)} aria-label={`選択肢 ${i + 1}`} />
              {options.length > 2 && (
                <button type="button" className="icon-btn" onClick={() => removeOption(i)} aria-label={`選択肢 ${i + 1} を消す`}>
                  <Icon name="trash" size={18} />
                </button>
              )}
            </div>
          ))}
          {options.length < MAX_OPTIONS && (
            <button type="button" className="btn-secondary wide" onClick={() => setOptions((list) => [...list, ""])}>
              <Icon name="plus" size={16} /> 選択肢を追加
            </button>
          )}

          <div className="poll-settings">
            <label className="poll-toggle">
              <span>
                <strong>複数選択を許可する</strong>
                <small className="muted">複数の選択肢に投票できます</small>
              </span>
              <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
            </label>
            <label className="poll-toggle">
              <span>
                <strong>匿名投票</strong>
                <small className="muted">誰が選んだかを表示しません</small>
              </span>
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
            </label>
          </div>

          {duplicated && <p className="error small">同じ選択肢があります。</p>}
          {error && <p className="error small">{error}</p>}
        </div>
      </div>
    </div>
  );
}
