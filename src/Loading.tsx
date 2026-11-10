import type { CSSProperties } from "react";

// 読み込み中の表示。点が順に跳ねるアニメーションと、トークを開いたときの仮の吹き出し
export function Dots() {
  return (
    <span className="dots" role="status" aria-label="読み込み中">
      <i />
      <i />
      <i />
    </span>
  );
}

// トークの中身を読み込んでいる間に出す、灰色の仮の吹き出し（相手の分はアイコンの場所も含めて出す）
const SKELETON_ROWS: { mine: boolean; width: string; lines?: number }[] = [
  { mine: false, width: "58%", lines: 2 },
  { mine: true, width: "40%" },
  { mine: false, width: "46%" },
  { mine: false, width: "64%", lines: 2 },
  { mine: true, width: "34%" },
  { mine: true, width: "52%", lines: 2 },
  { mine: false, width: "38%" }
];

export function ThreadSkeleton() {
  return (
    <div className="thread-skeleton" role="status" aria-busy="true" aria-label="メッセージを読み込んでいます">
      {SKELETON_ROWS.map((row, index) => (
        <div key={index} className={`sk-row${row.mine ? " mine" : ""}`} style={{ "--d": `${index * 90}ms` } as CSSProperties}>
          {!row.mine && <span className="sk-avatar" />}
          <span className="sk-bubble" style={{ width: row.width }}>
            {Array.from({ length: row.lines ?? 1 }, (_, line) => (
              <span key={line} className="sk-line" style={{ width: line === 0 && row.lines ? "88%" : "100%" }} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

// チャットの画面が読み込み終わるまで、全画面に出す表示。リングが回り、ロゴが浮き、点が順に跳ねる
export function ChatBootScreen({ leaving = false }: { leaving?: boolean }) {
  return (
    <div className={`chat-boot${leaving ? " leaving" : ""}`} role="status" aria-label="読み込み中">
      <div className="chat-boot-mark">
        <span className="chat-boot-ring" />
        <span className="chat-boot-logo">SoraChat</span>
      </div>
      <Dots />
    </div>
  );
}
