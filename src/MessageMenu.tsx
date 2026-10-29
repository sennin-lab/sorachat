import { REACTION_EMOJIS } from "./emojis";
import { Icon } from "./Icon";
import type { Message } from "./types";

export function MessageMenu({
  message,
  mine,
  onClose,
  onReact,
  onReply,
  onCopy,
  onEdit,
  onForward,
  onUnsend
}: {
  message: Message;
  mine: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onForward: () => void;
  onUnsend: () => void;
}) {
  const isText = message.kind === "text" && !message.deleted;

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
        {!message.deleted && (
          <button onClick={onReply}>
            <i className="fa-solid fa-reply" aria-hidden="true" /> 返信
          </button>
        )}
        {isText && (
          <button onClick={onCopy}>
            <Icon name="copy" size={20} /> コピー
          </button>
        )}
        {mine && isText && (
          <button onClick={onEdit}>
            <Icon name="edit" size={20} /> 編集
          </button>
        )}
        {!message.deleted && (
          <button onClick={onForward}>
            <Icon name="forward" size={20} /> 送信
          </button>
        )}
        {mine && !message.deleted && (
          <button className="danger" onClick={onUnsend}>
            <Icon name="unsend" size={20} /> 送信を取り消す
          </button>
        )}
        <button className="cancel" onClick={onClose}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
