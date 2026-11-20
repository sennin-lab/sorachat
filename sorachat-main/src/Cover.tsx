import type { CSSProperties, ReactNode } from "react";
import type { CoverTheme } from "./types";

// プロフィールの背景テーマ（LINE のプロフィールのように、色のグラデーションで背景を選べる）
export const COVER_THEMES: { id: CoverTheme; label: string; from: string; to: string }[] = [
  // id は保存済みの値との互換のため "green" のまま。見た目は薄い青
  { id: "green", label: "ライトブルー", from: "#b9dcfb", to: "#79b9ef" },
  { id: "sky", label: "スカイ", from: "#4fb8ff", to: "#2d6cdf" },
  { id: "sunset", label: "サンセット", from: "#ffb86b", to: "#ff5e7e" },
  { id: "lavender", label: "ラベンダー", from: "#b59cff", to: "#7057e6" },
  { id: "sand", label: "サンド", from: "#f7e3b0", to: "#e0a95b" },
  { id: "graphite", label: "グラファイト", from: "#5f6670", to: "#22262c" }
];

export const coverStyle = (theme: CoverTheme): CSSProperties => {
  const found = COVER_THEMES.find((t) => t.id === theme) ?? COVER_THEMES[0];
  return { background: `linear-gradient(135deg, ${found.from}, ${found.to})` };
};

// 背景が入るカバー部分。中身（アバターなど）は子要素として重ねる
export function Cover({ theme, children, className = "" }: { theme: CoverTheme; children?: ReactNode; className?: string }) {
  return (
    <div className={`cover ${className}`} style={coverStyle(theme)}>
      {children}
    </div>
  );
}
