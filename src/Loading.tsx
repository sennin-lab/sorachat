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

// トークの中身を読み込んでいる間に出す、灰色の仮の吹き出し
export function ThreadSkeleton() {
  return (
    <div className="thread-skeleton" role="status" aria-label="読み込み中">
      <span className="sk short" />
      <span className="sk" />
      <span className="sk mine" />
      <span className="sk short" />
      <span className="sk" />
      <span className="sk mine short" />
      <Dots />
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
