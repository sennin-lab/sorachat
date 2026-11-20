// senninai（AIチャット）のアイコン。ロボットの顔を線と面だけで描く（画像ファイルは使わない）
export const SENNIN_BOT_ID = "5e11a1ab-0000-4000-8000-000000000001";

export function RobotFace({ className }: { className?: string }) {
  return (
    <svg className={className ?? "robot-face"} viewBox="0 0 48 48" width="100%" height="100%" aria-hidden="true">
      <rect width="48" height="48" rx="24" fill="#8fb8de" />
      <line x1="24" y1="7" x2="24" y2="12" stroke="#33506e" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="24" cy="6" r="2.6" fill="#f2c94c" />
      <rect x="11" y="13" width="26" height="22" rx="7" fill="#f5f8fb" stroke="#33506e" strokeWidth="2" />
      <rect x="15" y="20" width="7" height="6" rx="2" fill="#33506e" />
      <rect x="26" y="20" width="7" height="6" rx="2" fill="#33506e" />
      <circle cx="18.5" cy="23" r="1.2" fill="#f5f8fb" />
      <circle cx="29.5" cy="23" r="1.2" fill="#f5f8fb" />
      <path d="M18 30.5 Q24 34 30 30.5" fill="none" stroke="#33506e" strokeWidth="2" strokeLinecap="round" />
      <rect x="15" y="37" width="18" height="6" rx="3" fill="#33506e" />
    </svg>
  );
}
