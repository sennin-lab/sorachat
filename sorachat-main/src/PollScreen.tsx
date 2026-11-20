import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import type { PollView } from "./types";

// 投票の全画面表示（LINE の投票画面と同じ構成）。
// 選択肢の票と割合、誰が選んだか（匿名のときは出さない）、作った人だけの「投票を締め切る」を出す
export function PollScreen({
  poll,
  meId,
  onVote,
  onClosePoll,
  onClose
}: {
  poll: PollView;
  meId: string;
  onVote: (index: number) => void;
  onClosePoll: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const closed = poll.closedAt !== null;
  const isCreator = poll.creatorId === meId;

  const confirmClose = () => {
    if (window.confirm("投票を締め切りますか？締め切ると、あとから選び直せなくなります。")) onClosePoll();
  };

  return createPortal(
    <div className="poll-screen" role="dialog" aria-modal="true" aria-label="投票">
      <header className="poll-screen-bar">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
          <Icon name="back" size={24} />
        </button>
        <strong>投票</strong>
        <span className="poll-screen-spacer" aria-hidden="true" />
      </header>

      <div className="poll-screen-body">
        <section className="poll-screen-head">
          <h2>{poll.question}</h2>
          <p className="muted small">
            {poll.voters}人が投票{poll.anonymous ? "・匿名投票" : ""}
            {poll.multiple ? "・複数選択できます" : ""}
          </p>
          {closed && <p className="poll-closed-note">この投票は締め切られています</p>}
        </section>

        <ul className="poll-screen-options">
          {poll.options.map((option, i) => {
            const count = poll.counts[i] ?? 0;
            const picked = poll.mine.includes(i);
            const percent = poll.voters ? Math.round((count / poll.voters) * 100) : 0;
            const voters = poll.voterDetails?.[i] ?? [];
            return (
              <li key={i} className={`poll-screen-option${picked ? " picked" : ""}`}>
                <button type="button" className="poll-screen-pick" aria-pressed={picked} disabled={closed} onClick={() => onVote(i)}>
                  <span className={`poll-mark${poll.multiple ? " square" : ""}${picked ? " on" : ""}`} aria-hidden="true">
                    {picked && <Icon name="check" size={12} />}
                  </span>
                  <span className="poll-screen-label">{option}</span>
                  <span className="poll-screen-count">
                    {count}票 <small>{percent}%</small>
                  </span>
                </button>
                <span className="poll-screen-track" aria-hidden="true">
                  <span className="poll-screen-fill" style={{ width: `${percent}%` }} />
                </span>
                {!poll.anonymous &&
                  (voters.length > 0 ? (
                    <ul className="poll-voters">
                      {voters.map((v) => (
                        <li key={v.id}>
                          <Avatar userId={v.id} hasAvatar={v.hasAvatar} name={v.name} size={28} />
                          <span>{v.name}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="poll-voters-empty">まだ選んだ人はいません</p>
                  ))}
              </li>
            );
          })}
        </ul>
        {poll.anonymous && <p className="poll-anon-note">匿名投票のため、誰が選んだかは表示されません。</p>}
      </div>

      {isCreator && !closed && (
        <footer className="poll-screen-foot">
          <button type="button" className="btn-secondary wide poll-close-btn" onClick={confirmClose}>
            投票を締め切る
          </button>
        </footer>
      )}
    </div>,
    document.body
  );
}
