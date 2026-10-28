import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { calls, useCall } from "./call";
import { formatElapsed } from "./format";

export function CallOverlay() {
  const state = useCall();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.status === "idle") return null;
  const { peer } = state;

  return (
    <div className="call">
      <div className="call-top">
        <Avatar userId={peer.id} hasAvatar={peer.hasAvatar} name={peer.name} size={112} />
        <h2>{peer.name}</h2>
        <p className="call-status">
          {state.status === "outgoing" && "発信中…"}
          {state.status === "incoming" && "着信中"}
          {state.status === "active" && (state.since ? formatElapsed(now - state.since) : "接続中…")}
        </p>
      </div>
      <div className="call-actions">
        {state.status === "incoming" ? (
          <>
            <button className="call-btn end" onClick={() => calls.decline()}>
              拒否
            </button>
            <button className="call-btn accept" onClick={() => calls.accept()}>
              応答
            </button>
          </>
        ) : (
          <>
            {state.status === "active" && (
              <button className={`call-btn ${state.muted ? "on" : ""}`} onClick={() => calls.toggleMute()}>
                {state.muted ? "ミュート中" : "マイク"}
              </button>
            )}
            <button className="call-btn end" onClick={() => calls.hangup()}>
              切断
            </button>
          </>
        )}
      </div>
    </div>
  );
}
