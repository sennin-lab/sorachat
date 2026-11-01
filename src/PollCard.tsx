import type { PollView } from "./types";
import { Icon } from "./Icon";

// 投票の吹き出しの中身。選択肢を押すと投票（もう一度押すと取り消し）
export function PollCard({ poll, onVote }: { poll: PollView; onVote: (index: number) => void }) {
  const top = Math.max(0, ...poll.counts);
  return (
    <div className="poll-card">
      <p className="poll-question">{poll.question}</p>
      <ul className="poll-options">
        {poll.options.map((option, i) => {
          const count = poll.counts[i] ?? 0;
          const picked = poll.mine.includes(i);
          return (
            <li key={i}>
              <button type="button" className={`poll-option${picked ? " picked" : ""}`} aria-pressed={picked} onClick={() => onVote(i)}>
                <span className="poll-bar" style={{ width: top ? `${(count / top) * 100}%` : "0%" }} aria-hidden="true" />
                <span className="poll-label">
                  {picked && <Icon name="check" size={14} />}
                  {option}
                </span>
                <span className="poll-count">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <small className="poll-meta">
        {poll.voters}人が投票{poll.multiple ? "・複数選択できます" : ""}
      </small>
    </div>
  );
}
