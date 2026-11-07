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
