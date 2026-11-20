import type { PollView } from "./types";
import { Icon } from "./Icon";

// 投票の吹き出しの中身（LINE の投票と同じく、選択肢を押すと投票、もう一度押すと取り消し）。
// 「結果を見る」か吹き出しをタップすると全画面の投票画面が開く
export function PollCard({ poll, onVote, onOpen }: { poll: PollView; onVote: (index: number) => void; onOpen: () => void }) {
  const closed = poll.closedAt !== null;
  return (
    <div className="poll-card">
      <div className="poll-head">
        <span className="poll-tag">
          <Icon name="poll" size={14} />
          投票
        </span>
        {closed && <span className="poll-closed-tag">締め切り</span>}
      </div>
      <p className="poll-question">{poll.question}</p>
      <ul className="poll-options">
        {poll.options.map((option, i) => {
          const count = poll.counts[i] ?? 0;
          const picked = poll.mine.includes(i);
          const percent = poll.voters ? Math.round((count / poll.voters) * 100) : 0;
          return (
            <li key={i}>
              <button
                type="button"
                className={`poll-option${picked ? " picked" : ""}`}
                aria-pressed={picked}
                disabled={closed}
                onClick={(e) => {
                  e.stopPropagation();
                  onVote(i);
                }}
              >
                <span className="poll-bar" style={{ width: `${percent}%` }} aria-hidden="true" />
                <span className={`poll-mark${poll.multiple ? " square" : ""}${picked ? " on" : ""}`} aria-hidden="true">
                  {picked && <Icon name="check" size={12} />}
                </span>
                <span className="poll-label">{option}</span>
                <span className="poll-count">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="poll-foot">
        <small className="poll-meta">
          {poll.voters}人が投票{poll.anonymous ? "・匿名" : ""}
          {poll.multiple ? "・複数選択可" : ""}
        </small>
        <button
          type="button"
          className="poll-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          結果を見る
        </button>
      </div>
    </div>
  );
}
