import { useExitClose } from "./useExitClose";
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
  onHide,
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
  onHide: () => void;
  onUnsend: () => void;
}) {
  const isText = message.kind === "text" && !message.deleted;

  const { closing, close } = useExitClose(onClose);
  return (
    <div className={`sheet-backdrop menu-backdrop${closing ? " is-closing" : ""}`} onClick={() => close()}>
      <div className={`msg-menu${closing ? " is-closing" : ""}`} role="menu" onClick={(e) => e.stopPropagation()}>
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
        {!message.deleted && message.kind !== "system" && message.kind !== "poll" && message.kind !== "game" && message.kind !== "call" && (
          <button onClick={onForward}>
            <Icon name="forward" size={20} /> 送信
          </button>
        )}
        {!message.deleted && (
          <button onClick={onHide}>
            <Icon name="trash" size={20} /> 自分の画面から削除
          </button>
        )}
        {mine && !message.deleted && (
          <button className="danger" onClick={onUnsend}>
            <Icon name="unsend" size={20} /> 送信を取り消す
          </button>
        )}
        <button className="cancel" onClick={() => close()}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
