import { REACTION_EMOJIS } from "./emojis";
import type { Message } from "./types";

export function MessageMenu({
  message,
  mine,
  onClose,
  onReact,
  onCopy,
  onEdit,
  onForward,
  onUnsend
}: {
  message: Message;
  mine: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onEdit: () => void;
  onForward: () => void;
  onUnsend: () => void;
}) {
  const isText = message.kind === "text" && !message.deleted;
  const preview = message.kind === "image" ? "写真" : message.body ?? "";

  return (
    <div className="sheet-backdrop menu-backdrop" onClick={onClose}>
      <div className="msg-menu" role="menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-reactions">
          {REACTION_EMOJIS.map((emoji) => (
            <button key={emoji} onClick={() => onReact(emoji)} aria-label={`${emoji} を付ける`}>
              {emoji}
            </button>
          ))}
        </div>
        {preview && <div className="menu-preview">{preview}</div>}
        {isText && (
          <button onClick={onCopy}>
            <i className="fa-regular fa-copy" /> コピー
          </button>
        )}
        {mine && isText && (
          <button onClick={onEdit}>
            <i className="fa-solid fa-pen" /> 編集
          </button>
        )}
        {!message.deleted && (
          <button onClick={onForward}>
            <i className="fa-solid fa-share" /> ほかの人に送信
          </button>
        )}
        {mine && !message.deleted && (
          <button className="danger" onClick={onUnsend}>
            <i className="fa-solid fa-rotate-left" /> 送信取り消し
          </button>
        )}
        <button className="cancel" onClick={onClose}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
