import { Icon } from "./Icon";

// 「＋」から開く添付メニュー
export function AttachSheet({
  onImage,
  onFile,
  onContact,
  onClose
}: {
  onImage: () => void;
  onFile: () => void;
  onContact: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet attach-sheet" role="dialog" aria-label="添付" onClick={(e) => e.stopPropagation()}>
        <button onClick={onImage}>
          <Icon name="image" size={22} /> <span>写真</span>
        </button>
        <button onClick={onFile}>
          <Icon name="file" size={22} /> <span>ファイル</span>
        </button>
        <button onClick={onContact}>
          <Icon name="card" size={22} /> <span>連絡先（SoraChat）</span>
        </button>
        <button className="cancel" onClick={onClose}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
