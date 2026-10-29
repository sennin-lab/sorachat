import {
  Fragment,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent
} from "react";
import { ApiError, api, delete_, patch, post } from "./api";
import { Avatar } from "./Avatar";
import { cachedMessages, saveMessages } from "./cache";
import { ForwardSheet } from "./ForwardSheet";
import { GroupSheet } from "./GroupSheet";
import { Icon } from "./Icon";
import { ImageViewer } from "./ImageViewer";
import { MessageMenu } from "./MessageMenu";
import { isSocketOpen, onChatEvent, sendChat } from "./realtime";
import { UserProfileSheet } from "./UserProfileSheet";
import { AttachSheet } from "./AttachSheet";
import { ContactSheet } from "./ContactSheet";
import type { Conversation, Message } from "./types";

type ContactInfo = NonNullable<Message["contact"]>;

const formatSize = (bytes?: number | null) => {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
const PAGE_SIZE = 50;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "送信できませんでした。通信状態を確認してください。";

// 返信元や入力欄の上に出す、メッセージ1件の短い説明
const messagePreview = (m: Message) => {
  if (m.deleted) return "送信を取り消しました";
  if (m.kind === "image") return "写真";
  if (m.kind === "file") return m.fileName ?? "ファイル";
  if (m.kind === "contact") return `連絡先 ${m.contact?.displayName ?? ""}`.trim();
  return m.body ?? "";
};

const downloadFile = (url: string, name?: string | null) => {
  const link = document.createElement("a");
  link.href = url;
  if (name) link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
};

type Reader = { id: string; lastReadAt: string };

// ダブルタップ判定（この時間内に同じ吹き出しを2回押すとメッセージのメニューを開く）
const DOUBLE_TAP_MS = 300;

const newClientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// IDで重複を除きつつ、後から渡した方（新しい情報）を優先してまとめる
const mergeById = (base: Message[], incoming: Message[]) => {
  const map = new Map<string, Message>();
  for (const m of base) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()];
};

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

// 日付の区切りに出す文言（今日は時刻のみ、昨日は「昨日」、それ以外は日付つき）
function dividerText(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  if (date.toDateString() === yesterday.toDateString()) return `昨日 ${time}`;
  const day = date.toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
  return `${day} ${time}`;
}

// 直前・直後と比べて「区切り線を出すか」「同じ人の連続として束ねるか」を判定する
function clockOf(iso: string) {
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function threadInfo(messages: Message[], index: number) {
  const m = messages[index];
  const prev = messages[index - 1];
  const next = messages[index + 1];
  const at = Date.parse(m.createdAt);

  const prevGap = prev ? at - Date.parse(prev.createdAt) : Infinity;
  const newSection = !prev || prevGap > HOUR || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
  const joinPrev = !newSection && prev.senderId === m.senderId && prevGap < 5 * MINUTE;

  const nextGap = next ? Date.parse(next.createdAt) - at : Infinity;
  const nextSection =
    !next || nextGap > HOUR || new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
  const joinNext = !nextSection && next.senderId === m.senderId && nextGap < 5 * MINUTE;

  return {
    divider: newSection ? dividerText(m.createdAt) : null,
    joinPrev,
    joinNext
  };
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
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  // 相手が既読にした時刻（1対1は1人分、グループは全員分）
  const [readers, setReaders] = useState<Reader[]>([]);
  // メンバーの名前（グループで送った人の名前を表示する）
  const [people, setPeople] = useState<Map<string, { name: string; hasAvatar: boolean }>>(new Map());
  // 新しく届いた・送った吹き出しだけ、出現アニメーションを付ける
  const enterIds = useRef(new Set<string>());
  // ハートを送ったときに浮かぶハートの一覧
  const [hearts, setHearts] = useState<number[]>([]);
  const [editing, setEditing] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [viewing, setViewing] = useState<Message | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactUser, setContactUser] = useState<ContactInfo | null>(null);
  const messagesRef = useRef(messages);
  const formRef = useRef<HTMLFormElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const anyFileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const prependHeight = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const tapTimer = useRef(0);
  const noticeTimer = useRef(0);
  const lastTap = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  // 返信先（入力欄の上に表示し、次に送るメッセージに付ける）
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  const commit = (next: Message[]) => {
    const sorted = [...next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    messagesRef.current = sorted;
    setMessages(sorted);
    saveMessages(conversationId, sorted.filter((m) => !m.status));
  };

  // 受信したメッセージを追加（同じ clientId の送信中表示は差し替える）
  const upsert = (incoming: Message[], dropClientId?: string | null) => {
    for (const m of incoming) {
      if (!messagesRef.current.some((x) => x.id === m.id)) enterIds.current.add(m.id);
    }
    const base = messagesRef.current.filter((m) => !(dropClientId && m.clientId === dropClientId));
    commit(mergeById(base, incoming));
  };

  const patchMessage = (id: string, change: (m: Message) => Message) =>
    commit(messagesRef.current.map((m) => (m.id === id ? change(m) : m)));

  const flash = (message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 1800);
  };

  const markRead = () => api(`/api/dm/${conversationId}/read`, post()).catch(() => undefined);

  // 既読状況（相手がどこまで読んだか）とメンバーの名前を取得する
  const loadReaders = async () => {
    try {
      const info = await api<{ readBy: Reader[]; members: { id: string; displayName: string; hasAvatar: boolean }[] }>(
        `/api/dm/${conversationId}`
      );
      setReaders(info.readBy);
      setPeople(new Map(info.members.map((m) => [m.id, { name: m.displayName, hasAvatar: m.hasAvatar }])));
    } catch {
      return;
    }
  };

  // 最新の50件を読み込む。キャッシュ済みの古いメッセージは消さずに残す
  const load = async () => {
    try {
      const list = await api<Message[]>(`/api/dm/${conversationId}/messages`);
      if (list.length < PAGE_SIZE) setHasOlder(false);
      const confirmed = messagesRef.current.filter((m) => !m.status);
      const pending = messagesRef.current.filter((m) => m.status);
      commit([...mergeById(confirmed, list), ...pending]);
      setError("");
    } catch (err) {
      // 読み込みに失敗したら、空の画面のまま黙らず理由を表示する
      setError(err instanceof ApiError ? err.message : "メッセージを読み込めませんでした。通信状態を確認してください。");
    }
  };

  // さらに古いメッセージを読み込む（表示位置は保ったまま上に追加する）
  const loadOlder = async () => {
    if (loadingOlderRef.current || !hasOlder) return;
    const oldest = messagesRef.current.find((m) => !m.status);
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const list = await api<Message[]>(
        `/api/dm/${conversationId}/messages?before=${encodeURIComponent(oldest.createdAt)}`
      );
      if (list.length < PAGE_SIZE) setHasOlder(false);
      prependHeight.current = threadRef.current?.scrollHeight ?? null;
      commit(mergeById(list, messagesRef.current));
    } catch {
      flash("読み込めませんでした");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    load();
    loadReaders();
    markRead();
    return onChatEvent((event) => {
      if (event.type === "hello") {
        load();
        loadReaders();
        return;
      }
      if (event.type === "read" && event.conversationId === conversationId && event.userId !== meId) {
        setReaders((current) =>
          current.some((r) => r.id === event.userId)
            ? current.map((r) => (r.id === event.userId ? { ...r, lastReadAt: event.readAt } : r))
            : [...current, { id: event.userId, lastReadAt: event.readAt }]
        );
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

  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  // 新しいメッセージが増えたときだけ最下部へ。過去分の追加では動かさない
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  // 過去分を上に足したあと、読んでいた位置がずれないように補正する
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (prependHeight.current !== null && el) {
      el.scrollTop += el.scrollHeight - prependHeight.current;
    }
    prependHeight.current = null;
  }, [messages]);

  const dispatch = async (temp: Message) => {
    try {
      const message = await sendChat({
        clientId: temp.clientId!,
        conversationId,
        body: temp.body ?? "",
        replyToId: temp.replyToId ?? null
      });
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
      void saveEdit(body);
      return;
    }
    enqueue(body);
  };

  const sendHeart = () => {
    if (editing) return;
    enqueue("❤️");
    const id = Date.now() + Math.random();
    setHearts((list) => [...list, id]);
    window.setTimeout(() => setHearts((list) => list.filter((x) => x !== id)), 1200);
  };

  const enqueue = (body: string) => {
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
      replyToId: replyTo?.id ?? null,
      reactions: []
    };
    setText("");
    setReplyTo(null);
    setError("");
    upsert([temp]);
    void dispatch(temp);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitText();
  };

  // スマホはEnterで改行したいので、マウス・キーボード操作のときだけEnterで送信する
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !coarse) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  // 画像・ファイルを送る（同じ形で送信し、返ってきたメッセージを表示する）
  const uploadFile = async (path: "image" | "file", file: File) => {
    const replyId = replyTo?.id ?? null;
    setReplyTo(null);
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      if (replyId) form.append("replyToId", replyId);
      const message = await api<Message>(`/api/dm/${conversationId}/${path}`, { method: "POST", body: form });
      upsert([message]);
      onActivity();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const pickImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void uploadFile("image", file);
  };

  const pickAnyFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void uploadFile("file", file);
  };

  const shareContact = async (username: string) => {
    const replyId = replyTo?.id ?? null;
    setReplyTo(null);
    setContactOpen(false);
    setBusy(true);
    setError("");
    try {
      const message = await api<Message>(`/api/dm/${conversationId}/contact`, post({ username, replyToId: replyId }));
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
    setMenuFor(null);
    try {
      await api(`/api/dm/messages/${messageId}/reactions`, post({ emoji }));
      if (!isSocketOpen()) void load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const startEdit = (m: Message) => {
    setMenuFor(null);
    setReplyTo(null);
    setEditing(m);
    setText(m.body ?? "");
    textRef.current?.focus();
  };

  // 返信: 入力欄の上に返信先を出す（編集中だった場合は編集をやめる）
  const startReply = (m: Message) => {
    setMenuFor(null);
    if (editing) {
      setEditing(null);
      setText("");
    }
    setReplyTo(m);
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

  // 1回タップの動き（画像は拡大、連絡先はプロフィール、ファイルはダウンロード）。
  // ダブルタップと区別するため、少し待ってから実行する
  const singleTapAction = (m: Message): (() => void) | null => {
    if (m.kind === "image" && m.imageUrl) return () => setViewing(m);
    if (m.kind === "contact" && m.contact) return () => setContactUser(m.contact ?? null);
    if (m.kind === "file" && m.fileUrl) return () => downloadFile(m.fileUrl!, m.fileName);
    return null;
  };

  // ダブルタップで、メッセージのメニュー（返信・コピー・編集・送信など）を開く
  const tapBubble = (m: Message) => {
    if (m.deleted || m.status) return;
    const now = Date.now();
    window.clearTimeout(tapTimer.current);
    if (lastTap.current.id === m.id && now - lastTap.current.at < DOUBLE_TAP_MS) {
      lastTap.current = { id: "", at: 0 };
      setMenuFor(m);
      if (navigator.vibrate) navigator.vibrate(12);
      return;
    }
    lastTap.current = { id: m.id, at: now };
    const action = singleTapAction(m);
    if (action) tapTimer.current = window.setTimeout(action, DOUBLE_TAP_MS);
  };

  const isGroup = conversation?.isGroup ?? false;
  const menu = menuFor;
  const hasText = text.trim().length > 0;
  const byId = new Map(messages.map((m): [string, Message] => [m.id, m]));
  const nameOf = (senderId: string) =>
    senderId === meId ? "自分" : isGroup ? people.get(senderId)?.name ?? "メンバー" : conversation?.name ?? "相手";
  const scrollToMessage = (id: string) =>
    document.getElementById(`msg-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });

  // Instagram と同じく、既読表示は「自分が送った最後のメッセージ」にだけ出す
  const lastMine = [...messages].reverse().find((m) => m.senderId === meId && !m.status && !m.deleted);
  const readLabelFor = (m: Message) => {
    if (!lastMine || lastMine.id !== m.id) return null;
    const at = Date.parse(m.createdAt);
    const readCount = readers.filter((r) => Date.parse(r.lastReadAt) >= at).length;
    if (readCount === 0) return "送信済み";
    return isGroup ? `既読 ${readCount}人` : "既読";
  };

  return (
    <section className="chat">
      <header className="chat-head">
        <button className="icon-btn back-btn" onClick={onBack} aria-label="戻る">
          <Icon name="back" size={26} />
        </button>
        <button
          className="head-who"
          onClick={() => (isGroup ? setShowInfo(true) : setShowProfile(true))}
          aria-label={isGroup ? "グループ情報" : "プロフィール"}
        >
          <span>
            <strong>{conversation?.name ?? ""}</strong>
            {conversation && isGroup && <span className="muted small">{conversation.memberCount}人</span>}
          </span>
        </button>
        {conversation && isGroup && (
          <button className="icon-btn" aria-label="グループ情報" onClick={() => setShowInfo(true)}>
            <Icon name="info" size={22} />
          </button>
        )}
      </header>

      <div className="thread" ref={threadRef}>
        {hasOlder && messages.length > 0 && (
          <button
            type="button"
            className="older-btn"
            disabled={loadingOlder}
            onClick={(e) => {
              e.stopPropagation();
              void loadOlder();
            }}
          >
            {loadingOlder ? "読み込み中…" : "以前のメッセージを表示"}
          </button>
        )}

        {messages.map((m, index) => {
          const info = threadInfo(messages, index);
          const mine = m.senderId === meId;
          const replyTarget = m.replyToId ? byId.get(m.replyToId) : undefined;
          const showImage = m.kind === "image" && !m.deleted && m.imageUrl;
          const hasStatus = Boolean(m.status) || (m.edited && !m.deleted);
          const sender = people.get(m.senderId);
          const avatarName = isGroup ? sender?.name ?? "" : conversation?.name ?? "";
          const avatarId = isGroup ? m.senderId : conversation?.otherId ?? "";
          const avatarHas = isGroup ? sender?.hasAvatar ?? false : conversation?.hasAvatar ?? false;
          const rowClass = [
            "row",
            mine ? "mine" : "",
            info.joinPrev ? "join-prev" : "group-start",
            info.joinNext ? "join-next" : "",
            enterIds.current.has(m.id) ? "enter" : ""
          ].join(" ");
          const meta = (
            <span className="msg-meta">
              {readLabelFor(m) && <span className="read-label">{readLabelFor(m)}</span>}
              {!info.joinNext && !m.status && !m.deleted && <time className="msg-time">{clockOf(m.createdAt)}</time>}
            </span>
          );
          return (
            <Fragment key={m.clientId ?? m.id}>
              {info.divider && (
                <div className="dm-divider">
                  <span>{info.divider}</span>
                </div>
              )}
              <div className={rowClass} id={`msg-${m.id}`}>
                {!mine && (
                  <div className="msg-avatar">
                    {!info.joinPrev && avatarId && <Avatar userId={avatarId} hasAvatar={avatarHas} name={avatarName} size={36} />}
                  </div>
                )}
                <div className="msg-wrap">
                  {!mine && isGroup && !info.joinPrev && sender && <span className="sender-name">{sender.name}</span>}
                  {m.forwarded && !m.deleted && (
                    <span className="fwd-label">
                      <Icon name="forward" size={13} /> 転送
                    </span>
                  )}
                  {m.replyToId && (
                    <button type="button" className="reply-quote" onClick={() => scrollToMessage(m.replyToId!)}>
                      <strong>{replyTarget ? nameOf(replyTarget.senderId) : "返信"}</strong>
                      <span>{replyTarget ? messagePreview(replyTarget) : "読み込んでいないメッセージ"}</span>
                    </button>
                  )}
                  <div className="bubble-line">
                    {mine && meta}
                    <div
                      className={`bubble ${showImage ? "image" : ""} ${m.deleted ? "deleted" : ""} ${m.status ? "pending" : ""} ${hasStatus ? "has-status" : ""}`}
                      onContextMenu={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        tapBubble(m);
                      }}
                    >
                      {m.deleted ? (
                        <p className="unsent">送信を取り消しました</p>
                      ) : showImage ? (
                        <img src={m.imageUrl!} alt="送信された画像" loading="lazy" draggable={false} />
                      ) : m.kind === "file" && m.fileUrl ? (
                        <a
                          className="file-card"
                          href={m.fileUrl}
                          download={m.fileName ?? undefined}
                          onClick={(e) => e.preventDefault()}
                        >
                          <Icon name="file" size={28} />
                          <span className="file-text">
                            <strong>{m.fileName}</strong>
                            <small>{formatSize(m.fileSize)}</small>
                          </span>
                        </a>
                      ) : m.kind === "contact" && m.contact ? (
                        <button type="button" className="contact-card">
                          <Avatar userId={m.contact.id} hasAvatar={m.contact.hasAvatar} name={m.contact.displayName} size={40} />
                          <span className="file-text">
                            <strong>{m.contact.displayName}</strong>
                            <small>@{m.contact.username}</small>
                          </span>
                        </button>
                      ) : (
                        <p>{m.body}</p>
                      )}
                      {hasStatus && (
                        <time>
                          {m.status === "sending"
                            ? "送信中…"
                            : m.status === "failed"
                              ? "送信できませんでした"
                              : m.edited && !m.deleted
                                ? "編集済み"
                                : ""}
                        </time>
                      )}
                    </div>
                    {!mine && meta}
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
                            void react(m.id, r.emoji);
                          }}
                        >
                          {r.emoji} {r.count}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error">{error}</p>}

      {replyTo && (
        <div className="reply-bar">
          <span className="reply-bar-text">
            <strong>{nameOf(replyTo.senderId)} に返信</strong>
            <small>{messagePreview(replyTo)}</small>
          </span>
          <button type="button" className="icon-btn" onClick={() => setReplyTo(null)} aria-label="返信をやめる">
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </div>
      )}

      {editing && (
        <div className="edit-bar">
          <span>
            <Icon name="edit" size={16} /> メッセージを編集中
          </span>
          <button type="button" className="chip" onClick={cancelEdit}>
            やめる
          </button>
        </div>
      )}

      <form className="composer" ref={formRef} onSubmit={onSubmit}>
        <span className="float-hearts" aria-hidden="true">
          {hearts.map((id, i) => (
            <span key={id} className="float-heart" style={{ "--dx": `${(i % 3) * 14 - 14}px` } as CSSProperties}>
              ❤️
            </span>
          ))}
        </span>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={pickImage} />
        <input ref={anyFileRef} type="file" hidden onChange={pickAnyFile} />
        <button
          type="button"
          className="composer-icon plus"
          onClick={() => setAttachOpen(true)}
          aria-label="添付"
          disabled={busy || Boolean(editing)}
        >
          <Icon name="plus" size={26} />
        </button>
        <div className="composer-field">
          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={1000}
            placeholder={editing ? "メッセージを編集" : "メッセージを入力…"}
            aria-label="メッセージ"
          />
        </div>
        {hasText || editing ? (
          <button className="send-btn" disabled={busy || !hasText} aria-label={editing ? "保存" : "送信"}>
            <i className={editing ? "fa-solid fa-check" : "fa-solid fa-paper-plane"} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="composer-icon heart" onClick={sendHeart} aria-label="❤️を送る">
            <Icon name="heart" size={26} />
          </button>
        )}
      </form>

      {menu && (
        <MessageMenu
          message={menu}
          mine={menu.senderId === meId}
          onClose={() => setMenuFor(null)}
          onReact={(emoji) => void react(menu.id, emoji)}
          onReply={() => startReply(menu)}
          onCopy={() => void copy(menu)}
          onEdit={() => startEdit(menu)}
          onForward={() => {
            setMenuFor(null);
            setForwarding(menu);
          }}
          onUnsend={() => void unsend(menu)}
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
      {attachOpen && (
        <AttachSheet
          onClose={() => setAttachOpen(false)}
          onImage={() => {
            setAttachOpen(false);
            fileRef.current?.click();
          }}
          onFile={() => {
            setAttachOpen(false);
            anyFileRef.current?.click();
          }}
          onContact={() => {
            setAttachOpen(false);
            setContactOpen(true);
          }}
        />
      )}
      {contactOpen && (
        <ContactSheet
          meId={meId}
          onPick={(username) => void shareContact(username)}
          onClose={() => setContactOpen(false)}
        />
      )}
      {contactUser && <UserProfileSheet userId={contactUser.id} onClose={() => setContactUser(null)} />}
      {showProfile && conversation?.otherId && (
        <UserProfileSheet userId={conversation.otherId} onClose={() => setShowProfile(false)} />
      )}
    </section>
  );
}
