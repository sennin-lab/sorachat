// グループ電話の画面（LINE のグループ通話に近い配置：参加者のアバターを並べ、下に丸いボタンを置く）
import { useEffect, useState, useSyncExternalStore } from "react";
import { Avatar } from "./Avatar";
import {
  acceptCall,
  declineCall,
  getCallState,
  leaveCall,
  onCallState,
  setIdentity,
  toggleMute,
  startCallInbox,
  type CallPeer
} from "./groupCall";
import type { Me } from "./types";

const useCallState = () => useSyncExternalStore(onCallState, getCallState);

const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
};

// アプリ全体に1つだけ置く。着信の受付・通話画面の表示を担当
export function GroupCallHost({ me }: { me: Me }) {
  const call = useCallState();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const identity: CallPeer = { id: me.id, name: me.displayName || me.username, hasAvatar: me.hasAvatar };
    setIdentity(identity);
    startCallInbox(me.id).catch(() => {});
  }, [me.id, me.displayName, me.username, me.hasAvatar]);

  useEffect(() => {
    if (call.status !== "active") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [call.status]);

  if (call.status === "idle") return null;

  if (call.status === "incoming") {
    const { caller, groupName } = call.invite;
    return (
      <div className="gcall gcall-incoming" role="dialog" aria-label="グループ通話の着信">
        <div className="gcall-bg" aria-hidden="true" />
        <div className="gcall-top">
          <Avatar userId={caller.id} hasAvatar={caller.hasAvatar} name={caller.name} size={120} />
          <p className="gcall-name">{caller.name}</p>
          <p className="gcall-sub">{groupName}からグループ通話</p>
        </div>
        <div className="gcall-actions gcall-actions-two">
          <div className="gcall-btn-wrap">
            <button className="gcall-circle gcall-end" onClick={declineCall} aria-label="拒否">
              <PhoneIcon />
            </button>
            <span>拒否</span>
          </div>
          <div className="gcall-btn-wrap">
            <button className="gcall-circle gcall-accept" onClick={() => acceptCall().catch(() => declineCall())} aria-label="応答">
              <PhoneIcon />
            </button>
            <span>応答</span>
          </div>
        </div>
      </div>
    );
  }

  const count = call.participants.length;
  return (
    <div className="gcall" role="dialog" aria-label="グループ通話">
      <div className="gcall-bg" aria-hidden="true" />
      <div className="gcall-top">
        <p className="gcall-sub">{call.groupName}</p>
        <p className="gcall-time">{call.ringing ? "呼び出し中…" : formatElapsed(now - call.startedAt)}</p>
      </div>
      <div className={`gcall-grid gcall-grid-${Math.min(count, 4)}`}>
        {call.participants.map((p) => (
          <div className="gcall-member" key={p.id}>
            <Avatar userId={p.id} hasAvatar={p.hasAvatar} name={p.name} size={count > 2 ? 84 : 120} />
            <span>{p.name}</span>
          </div>
        ))}
      </div>
      <div className="gcall-actions">
        <div className="gcall-btn-wrap">
          <button
            className={`gcall-circle${call.muted ? " is-on" : ""}`}
            onClick={toggleMute}
            aria-pressed={call.muted}
            aria-label={call.muted ? "ミュート解除" : "ミュート"}
          >
            <MicIcon off={call.muted} />
          </button>
          <span>{call.muted ? "解除" : "ミュート"}</span>
        </div>
        <div className="gcall-btn-wrap">
          <button className="gcall-circle gcall-end" onClick={() => leaveCall()} aria-label="退出">
            <PhoneIcon />
          </button>
          <span>退出</span>
        </div>
      </div>
    </div>
  );
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true" style={{ transform: "rotate(135deg)" }}>
      <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
    </svg>
  );
}
