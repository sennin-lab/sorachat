// トークに出るグループ通話のカード。通話中なら「電話に参加」を出す
import type { Message } from "./types";

type Props = { call: NonNullable<Message["call"]>; onJoin: () => void };

export function CallCard({ call, onJoin }: Props) {
  return (
    <div className="call-card">
      <div className="call-card-head">
        <span className={`call-card-icon${call.active ? " is-live" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
          </svg>
        </span>
        <div className="call-card-text">
          <strong>グループ通話</strong>
          <span>{call.active ? "通話中" : "通話は終了しました"}</span>
        </div>
      </div>
      {call.active && (
        <button
          type="button"
          className="call-card-join"
          onClick={(e) => {
            e.stopPropagation();
            onJoin();
          }}
        >
          電話に参加
        </button>
      )}
    </div>
  );
}
