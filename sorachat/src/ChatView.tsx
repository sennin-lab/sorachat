import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { ApiError, api, delete_, patch, post } from "./api";
import { Avatar } from "./Avatar";
import { calls } from "./call";
import { cachedMessages, saveMessages } from "./cache";
import { formatTime } from "./format";
import { ForwardSheet } from "./ForwardSheet";
import { GroupSheet } from "./GroupSheet";
import { ImageViewer } from "./ImageViewer";
import { MessageMenu } from "./MessageMenu";
import { REACTION_EMOJIS } from "./emojis";
import { isSocketOpen, onChatEvent, sendChat } from "./realtime";
import { UserProfileSheet } from "./UserProfileSheet";
import type { Conversation, Message } from "./types";
import "./messages.css";

const LONG_PRESS_MS = 450;

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "送信できませんでした。通信状態を確認してください。";

const newClientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function ChatView({
  conversationId,
  meId,
  conversation,
  conversations,
  onBack,
  onActivity
}: {
  conversationId: string;
  meId: string;
  conversation: Conversation | null;
  conversations: Conversation[];
  onBack: () => void;
  onActivity: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>(() => cachedMessages(conversationId));
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [viewing, setViewing] = useState<Message | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const messagesRef = useRef(messages);
  const formRef = useRef<HTMLFormElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef(0);
  const pressed = useRef(false);
  const noticeTimer = useRef(0);

  const commit = (next: Message[]) => {
    const sorted = [...next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    messagesRef.current = sorted;
    setMessages(sorted);
    saveMessages(conversationId, sorted.filter((m) => !m.status));
  };

  // 受信したメッセージを追加（同じ clientId の送信中表示は差し替える）
  const upsert = (incoming: Message[], dropClientId?: string | null) => {
    const known = new Map(
      messagesRef.current.filter((m) => !(dropClientId && m.clientId === dropClientId)).map((m) => [m.id, m])
    );
    for (const m of incoming) if (!known.has(m.id)) known.set(m.id, m);
    commit([...known.values()]);
  };

  const patchMessage = (id: string, change: (m: Message) => Message) =>
    commit(messagesRef.current.map((m) => (m.id === id ? change(m) : m)));

  const flash = (message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 1800);
  };

  const markRead = () => api(`/api/dm/${conversationId}/read`, post()).catch(() => undefined);

  const load = async () => {
    try {
      const list = await api<Message[]>(`/api/dm/${conversationId}/messages`);
      const pendingLocal = messagesRef.current.filter((m) => m.status);
      commit([...list, ...pendingLocal]);
    } catch {
      return;
    }
  };

  useEffect(() => {
    load();
    markRead();
    return onChatEvent((event) => {
      if (event.type === "hello") {
        load();
        return;
      }
      if (event.type === "message" && event.message.conversationId === conversationId) {
        upsert([event.message], event.message.clientId);
        if (event.message.senderId !== meId) markRead();
        onActivity();
        return;
      }
      if (event.type === "message_updated" && event.conversationId === conversationId) {
        patchMessage(event.id, (m) => ({ ...m, body: event.body, edited: true }));
        return;
      }
      if (event.type === "message_deleted" && event.conversationId === conversationId) {
        patchMessage(event.id, (m) => ({ ...m, deleted: true, body: null, imageUrl: null, reactions: [] }));
        return;
      }
      if (event.type === "reactions" && event.conversationId === conversationId) {
        patchMessage(event.messageId, (m) => ({ ...m, reactions: event.reactions }));
      }
    });
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const dispatch = async (temp: Message) => {
    try {
      const message = await sendChat({ clientId: temp.clientId!, conversationId, body: temp.body ?? "" });
      upsert([message], temp.clientId);
      onActivity();
    } catch {
      patchMessage(temp.id, (m) => ({ ...m, status: "failed" }));
      setError("送信できませんでした。通信状態を確認してください。");
    }
  };

  const saveEdit = async (body: string) => {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/dm/messages/${editing.id}`, patch({ body }));
      patchMessage(editing.id, (m) => ({ ...m, body, edited: true }));
      setEditing(null);
      setText("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitText = () => {
    const body = text.trim();
    if (!body) return;
    if (editing) {
      saveEdit(body);
      return;
    }
    const clientId = newClientId();
    const temp: Message = {
      id: `tmp-${clientId}`,
      clientId,
      status: "sending",
      conversationId,
      senderId: meId,
      kind: "text",
      body,
      imageUrl: null,
      createdAt: new Date().toISOString(),
      edited: false,
      deleted: false,
      forwarded: false,
      reactions: []
    };
    setText("");
    setError("");
    upsert([temp]);
    void dispatch(temp);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitText();
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
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const message = await api<Message>(`/api/dm/${conversationId}/image`, { method: "POST", body: form });
      upsert([message]);
      onActivity();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const retry = (m: Message) => {
    patchMessage(m.id, (x) => ({ ...x, status: "sending" }));
    void dispatch({ ...m, status: "sending" });
  };

  const discard = (m: Message) => commit(messagesRef.current.filter((x) => x.id !== m.id));

  const react = async (messageId: string, emoji: string) => {
    setPickerFor(null);
    setMenuFor(null);
    try {
      await api(`/api/dm/messages/${messageId}/reactions`, post({ emoji }));
      if (!isSocketOpen()) load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const startEdit = (m: Message) => {
    setMenuFor(null);
    setEditing(m);
    setText(m.body ?? "");
    textRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditing(null);
    setText("");
  };

  const copy = async (m: Message) => {
    setMenuFor(null);
    const ok = await copyText(m.body ?? "");
    flash(ok ? "コピーしました" : "コピーできませんでした");
  };

  const unsend = async (m: Message) => {
    setMenuFor(null);
    if (!window.confirm("このメッセージを送信取り消ししますか？")) return;
    try {
      await api(`/api/dm/messages/${m.id}`, delete_());
      patchMessage(m.id, (x) => ({ ...x, deleted: true, body: null, imageUrl: null, reactions: [] }));
      onActivity();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const forwardTo = async (targetId: string) => {
    const target = forwarding;
    setForwarding(null);
    if (!target) return;
    try {
      await api(`/api/dm/messages/${target.id}/forward`, post({ conversationId: targetId }));
      flash("送信しました");
      onActivity();
    } catch (err) {
      setError(errorText(err));
    }
  };

  // 長押しでメニュー。指が動いたり離れたりしたら取り消す
  const startPress = (m: Message) => (event: PointerEvent) => {
    if (m.status || event.button > 0) return;
    pressed.current = false;
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      pressed.current = true;
      setPickerFor(null);
      setMenuFor(m);
      if (navigator.vibrate) navigator.vibrate(12);
    }, LONG_PRESS_MS);
  };

  const endPress = () => window.clearTimeout(pressTimer.current);

  const isGroup = conversation?.isGroup ?? false;
  const menu = menuFor;

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
            <i className="fa-solid fa-phone" />
          </button>
        )}
      </header>

      <div className="thread" onClick={() => setPickerFor(null)}>
        {messages.map((m) => {
          const mine = m.senderId === meId;
          const showImage = m.kind === "image" && !m.deleted && m.imageUrl;
          return (
            <div key={m.id} className={`row ${mine ? "mine" : ""}`}>
              <div className="msg-wrap">
                {m.forwarded && !m.deleted && (
                  <span className="fwd-label">
                    <i className="fa-solid fa-share" /> 転送
                  </span>
                )}
                <div
                  className={`bubble ${showImage ? "image" : ""} ${m.deleted ? "deleted" : ""} ${m.status ? "pending" : ""}`}
                  onPointerDown={startPress(m)}
                  onPointerUp={endPress}
                  onPointerLeave={endPress}
                  onPointerMove={endPress}
                  onPointerCancel={endPress}
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (pressed.current) {
                      pressed.current = false;
                      return;
                    }
                    if (m.deleted || m.status) return;
                    if (showImage) {
                      setViewing(m);
                      return;
                    }
                    setPickerFor(pickerFor === m.id ? null : m.id);
                  }}
                >
                  {m.deleted ? (
                    <p className="unsent">送信を取り消しました</p>
                  ) : showImage ? (
                    <img src={m.imageUrl!} alt="送信された画像" loading="lazy" draggable={false} />
                  ) : (
                    <p>{m.body}</p>
                  )}
                  <time>
                    {m.status === "sending"
                      ? "送信中…"
                      : m.status === "failed"
                        ? "送信できませんでした"
                        : `${m.edited && !m.deleted ? "編集済み · " : ""}${formatTime(m.createdAt)}`}
                  </time>
                </div>
                {m.status === "failed" && (
                  <div className="retry-row">
                    <button className="chip retry" onClick={() => retry(m)}>
                      再送
                    </button>
                    <button className="chip" onClick={() => discard(m)}>
                      削除
                    </button>
                  </div>
                )}
                {m.reactions.length > 0 && !m.deleted && (
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
                {pickerFor === m.id && !m.deleted && (
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

      {editing && (
        <div className="edit-bar">
          <span>
            <i className="fa-solid fa-pen" /> メッセージを編集中
          </span>
          <button type="button" className="chip" onClick={cancelEdit}>
            やめる
          </button>
        </div>
      )}

      <form className="composer" ref={formRef} onSubmit={onSubmit}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => fileRef.current?.click()}
          aria-label="画像を添付"
          disabled={Boolean(editing)}
        >
          ＋
        </button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={pickImage} />
        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={1000}
          placeholder="メッセージ"
        />
        <button className="btn primary send" disabled={busy || !text.trim()}>
          {editing ? "保存" : "送信"}
        </button>
      </form>

      {menu && (
        <MessageMenu
          message={menu}
          mine={menu.senderId === meId}
          onClose={() => setMenuFor(null)}
          onReact={(emoji) => react(menu.id, emoji)}
          onCopy={() => copy(menu)}
          onEdit={() => startEdit(menu)}
          onForward={() => {
            setMenuFor(null);
            setForwarding(menu);
          }}
          onUnsend={() => unsend(menu)}
        />
      )}
      {forwarding && (
        <ForwardSheet
          conversations={conversations.filter((c) => c.id !== conversationId)}
          onPick={forwardTo}
          onClose={() => setForwarding(null)}
        />
      )}
      {viewing?.imageUrl && (
        <ImageViewer src={viewing.imageUrl} id={viewing.id} onClose={() => setViewing(null)} />
      )}
      {notice && <div className="toast">{notice}</div>}

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
