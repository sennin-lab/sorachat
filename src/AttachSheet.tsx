import { Icon } from "./Icon";
import { useExitClose } from "./useExitClose";

// 「＋」から開く添付メニュー。写真・ファイルは、ファイル選択を直接開くためすぐに呼ぶ
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
  const { closing, close } = useExitClose(onClose);
  return (
    <div className={`sheet-backdrop${closing ? " is-closing" : ""}`} onClick={() => close()}>
      <div
        className={`sheet attach-sheet${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-label="添付"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-title-row">
          <span />
          <strong>添付</strong>
          <button type="button" className="icon-btn modal-x" onClick={() => close()} aria-label="閉じる">
            ×
          </button>
        </div>
        <button onClick={onImage}>
          <Icon name="image" size={22} /> <span>写真</span>
        </button>
        <button onClick={onFile}>
          <Icon name="file" size={22} /> <span>ファイル</span>
        </button>
        <button onClick={onContact}>
          <Icon name="card" size={22} /> <span>連絡先（SoraChat）</span>
        </button>
        <button className="cancel" onClick={() => close()}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
