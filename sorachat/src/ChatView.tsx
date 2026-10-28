import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, api, post } from "./api";
import { Avatar } from "./Avatar";
import { calls } from "./call";
import { cachedMessages, saveMessages } from "./cache";
import { formatTime } from "./format";
import { GroupSheet } from "./GroupSheet";
import { onDataEvent } from "./realtime";
import { REACTION_EMOJIS } from "./emojis";
import { UserProfileSheet } from "./UserProfileSheet";
import type { Conversation, Message } from "./types";

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "送信できませんでした。通信状態を確認してください。";

const fromRow = (row: Record<string, any>): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  kind: row.kind,
  body: row.body,
  imageUrl: row.kind === "image" ? `/api/dm/messages/${row.id}/image` : null,
  createdAt: row.created_at,
  reactions: []
});

export function ChatView({
  conversationId,
  meId,
  conversation,
  onBack,
  onActivity
}: {
  conversationId: string;
  meId: string;
  conversation: Conversation | null;
  onBack: () => void;
  onActivity: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>(() => cachedMessages(conversationId));
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const messagesRef = useRef(messages);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const commit = (next: Message[]) => {
    messagesRef.current = next;
    setMessages(next);
    saveMessages(conversationId, next);
  };

  const merge = (incoming: Message[]) => {
    const known = new Map(messagesRef.current.map((m) => [m.id, m]));
    for (const m of incoming) if (!known.has(m.id)) known.set(m.id, m);
    commit([...known.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  };

  const markRead = () => api(`/api/dm/${conversationId}/read`, post()).catch(() => undefined);

  const load = async () => {
    try {
      const list = await api<Message[]>(`/api/dm/${conversationId}/messages`);
      commit(list);
    } catch {
      return;
    }
  };

  useEffect(() => {
    load();
    markRead();
    return onDataEvent((event) => {
      if (event.kind === "message" && event.row.conversation_id === conversationId) {
        const message = fromRow(event.row);
        merge([message]);
        if (message.senderId !== meId) markRead();
        onActivity();
      }
      if (event.kind === "reaction" && messagesRef.current.some((m) => m.id === event.row.message_id)) {
        load();
      }
    });
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const message = await api<Message>(`/api/dm/${conversationId}/messages`, post({ body }));
      setText("");
      merge([message]);
      onActivity();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const pickImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSending(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const message = await api<Message>(`/api/dm/${conversationId}/image`, { method: "POST", body: form });
      merge([message]);
      onActivity();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const react = async (messageId: string, emoji: string) => {
    setPickerFor(null);
    try {
      await api(`/api/dm/messages/${messageId}/reactions`, post({ emoji }));
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const isGroup = conversation?.isGroup ?? false;

  return (
    <section className="chat">
      <header className="chat-head">
        <button className="icon-btn" onClick={onBack} aria-label="戻る">
          ‹
        </button>
        <button
          className="head-who"
          onClick={() => (isGroup ? setShowInfo(true) : setShowProfile(true))}
          aria-label={isGroup ? "グループ情報" : "プロフィール"}
        >
          <Avatar
            userId={isGroup ? "" : conversation?.otherId ?? ""}
            hasAvatar={conversation?.hasAvatar ?? false}
            name={conversation?.name ?? ""}
            size={34}
          />
          <span>
            <strong>{conversation?.name ?? ""}</strong>
            {conversation && (
              <span className="muted small">{isGroup ? `${conversation.memberCount}人` : `@${conversation.otherUsername}`}</span>
            )}
          </span>
        </button>
        {conversation && !isGroup && conversation.otherId && (
          <button
            className="icon-btn"
            aria-label="通話"
            onClick={() =>
              calls.start({ id: conversation.otherId!, name: conversation.name, hasAvatar: conversation.hasAvatar })
            }
          >
            📞
          </button>
        )}
      </header>

      <div className="thread" onClick={() => setPickerFor(null)}>
        {messages.map((m) => {
          const mine = m.senderId === meId;
          return (
            <div key={m.id} className={`row ${mine ? "mine" : ""}`}>
              <div className="msg-wrap">
                <div
                  className={`bubble ${m.kind === "image" ? "image" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPickerFor(pickerFor === m.id ? null : m.id);
                  }}
                >
                  {m.kind === "image" && m.imageUrl ? (
                    <img src={m.imageUrl} alt="送信された画像" loading="lazy" />
                  ) : (
                    <p>{m.body}</p>
                  )}
                  <time>{formatTime(m.createdAt)}</time>
                </div>
                {m.reactions.length > 0 && (
                  <div className="chips">
                    {m.reactions.map((r) => (
                      <button
                        key={r.emoji}
                        className={`chip ${r.mine ? "mine" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          react(m.id, r.emoji);
                        }}
                      >
                        {r.emoji} {r.count}
                      </button>
                    ))}
                  </div>
                )}
                {pickerFor === m.id && (
                  <div className="picker" onClick={(e) => e.stopPropagation()}>
                    {REACTION_EMOJIS.map((emoji) => (
                      <button key={emoji} onClick={() => react(m.id, emoji)} aria-label={`${emoji} を付ける`}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error">{error}</p>}

      <form className="composer" ref={formRef} onSubmit={onSubmit}>
        <button type="button" className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="画像を添付">
          ＋
        </button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={pickImage} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={1000}
          placeholder="メッセージ"
        />
        <button className="btn primary send" disabled={sending || !text.trim()}>
          送信
        </button>
      </form>

      {showInfo && conversation && (
        <GroupSheet
          conversationId={conversationId}
          meId={meId}
          onClose={() => setShowInfo(false)}
          onLeft={onBack}
          onChanged={onActivity}
        />
      )}
      {showProfile && conversation?.otherId && (
        <UserProfileSheet userId={conversation.otherId} onClose={() => setShowProfile(false)} />
      )}
    </section>
  );
}
