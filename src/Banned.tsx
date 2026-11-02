import { useEffect, useState } from "react";
import type { BanInfo } from "./types";

// 利用停止の表示。ログアウトはできない。期限つきなら残り時間を数え、終わったら利用できるか確かめ直す
export function BannedScreen({ ban, onRecheck }: { ban: BanInfo; onRecheck: () => void }) {
  const until = ban.until ? new Date(ban.until).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  const remaining = until === null ? null : Math.max(0, until - now);
  const ended = remaining === 0;

  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [until]);

  // 期限が来たら、サーバーに確かめ直す（まだ利用停止なら、この画面のまま数え直す）
  useEffect(() => {
    if (!ended) return;
    const timer = window.setTimeout(onRecheck, 1500);
    return () => window.clearTimeout(timer);
  }, [ended, ban, onRecheck]);

  if (ban.permanent) {
    return (
      <div className="banned banned-final">
        <div className="banned-card">
          <p className="banned-tag">バンされました</p>
          <h1 className="banned-goodbye">さようなら</h1>
          <p className="banned-text">このアカウントは永久に利用停止になりました。</p>
          <p className="banned-note">利用停止中はログアウトできません。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="banned">
      <div className="banned-card">
        <p className="banned-tag">バンされました</p>
        <h1 className="banned-title">このアカウントは利用停止中です</h1>
        <div className="banned-count" aria-live="polite">
          <span className="banned-count-label">{ended ? "まもなく利用できるか確認します" : "利用再開まで"}</span>
          <strong className="banned-count-time">{ended ? "…" : formatRemaining(remaining ?? 0)}</strong>
        </div>
        <p className="banned-text">
          解除日時：{ban.until ? new Date(ban.until).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
        </p>
        <p className="banned-note">利用停止中はログアウトできません。期限が過ぎると自動で利用できるようになります。</p>
      </div>
    </div>
  );
}

// 残り時間を「1日 03:24:10」「03:24:10」の形にする（切り上げで、0秒のまま止まって見えないように）
export function formatRemaining(ms: number) {
  const total = Math.ceil(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const hms = [hours, minutes, seconds].map((n) => String(n).padStart(2, "0")).join(":");
  return days > 0 ? `${days}日 ${hms}` : hms;
}
