import { REACTION_EMOJIS } from "./emojis";
import { Icon } from "./Icon";
import type { Message } from "./types";

export function MessageMenu({
  message,
  mine,
  onClose,
  onReact,
  onCopy,
  onEdit,
  onForward,
  onReply,
  onUnsend
}: {
  message: Message;
  mine: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onEdit: () => void;
  onForward: () => void;
  onReply: () => void;
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
          <button onClick={onReply}>
            <Icon name="reply" size={20} /> 返信
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
