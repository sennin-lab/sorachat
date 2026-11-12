import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent
} from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, delete_, post } from "./api";
import { Avatar } from "./Avatar";
import { SenninaiConfirm } from "./SenninaiConfirm";
import { RoomSettingsSheet } from "./RoomSettingsSheet";
import { SENNIN_BOT_ID } from "./robot";
import { cachedMessages, loadMessagesDb, loadPeopleDb, saveMessages, savePeopleDb, type PersonInfo } from "./cache";
import { rememberAvatars, syncAvatars } from "./avatarCache";
import { clipLongWords } from "./clip";
import { ForwardSheet } from "./ForwardSheet";
import { GroupSheet } from "./GroupSheet";
import { getCallState, joinCallFromChat, startGroupCall } from "./groupCall";
import { CallCard } from "./CallCard";
import { Icon } from "./Icon";
import { ImageViewer } from "./ImageViewer";
import { MessageMenu } from "./MessageMenu";
import { isSocketOpen, onChatEvent, sendChat, sendGameAction, sendTyping } from "./realtime";
import { UserProfileSheet } from "./UserProfileSheet";
import { AttachSheet } from "./AttachSheet";
import { StampSheet } from "./StampSheet";
import { stampNameOf, stampUrlOf } from "./stamps";
import { PREFS_EVENT, getShowUnsent } from "./prefs";
import { ContactSheet } from "./ContactSheet";
import { PollCard } from "./PollCard";
import { PollSheet, type PollDraft } from "./PollSheet";
import { PollScreen } from "./PollScreen";
import { FileViewer, viewerKindOf } from "./FileViewer";
import { GameCard } from "./GameCard";
import { GameSheet } from "./GameSheet";
import { RichText } from "./LinkText";
import { CodeMessage } from "./CodeMessage";
import { ThreadSkeleton } from "./Loading";
import type { Conversation, FriendshipState, GameKind, Member, Message } from "./types";

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
  if (m.kind === "stamp") return "スタンプ";
  if (m.kind === "poll") return `投票: ${m.body ?? ""}`;
  if (m.kind === "game") return "ミニゲーム";
  if (m.kind === "call") return "通話";
  // 「\n」という文字のまま届いた改行は、一行の説明では空白にする
  return clipLongWords((m.body ?? "").replace(/\\n/g, " "));
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

// 入力中の表示：送るのは2.5秒に1回まで、受け取った表示は4秒で消える（届かなくなったときも消えるように）
const TYPING_SEND_GAP_MS = 2500;
const TYPING_HOLD_MS = 4000;

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
  // 最新の読み込みが終わったか（終わるまで、中身がなければ読み込み表示を出す）
  const [loaded, setLoaded] = useState(false);
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
  const [people, setPeople] = useState<Map<string, PersonInfo>>(new Map());
  const peopleRef = useRef<Map<string, PersonInfo>>(new Map());
  // 開く前に読んでいた時刻（この後のメッセージが未読）。undefined は未確認、null は分からない
  const [unreadFrom, setUnreadFrom] = useState<string | null | undefined>(undefined);
  const initialPositioned = useRef(false);
  // 新しく届いた・送った吹き出しだけ、出現アニメーションを付ける
  const enterIds = useRef(new Set<string>());
  // ハートを送ったときに浮かぶハートの一覧
  const [stampOpen, setStampOpen] = useState(false);
  const [editing, setEditing] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [viewing, setViewing] = useState<Message | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showRoom, setShowRoom] = useState(false);
  const navigate = useNavigate();
  // 1対1の相手とのフレンド状態（申請の許可・拒否バナーに使う）
  const [friendship, setFriendship] = useState<FriendshipState | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactUser, setContactUser] = useState<ContactInfo | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  // 全画面で開いている投票（メッセージID）と、トーク内で開いているファイル
  const [pollViewingId, setPollViewingId] = useState<string | null>(null);
  const [fileViewing, setFileViewing] = useState<Message | null>(null);
  const [gameOpen, setGameOpen] = useState(false);
  // 「送信取り消しました」を表示するか（設定で切り替える）
  const [showUnsent, setShowUnsent] = useState(getShowUnsent);
  useEffect(() => {
    const sync = () => setShowUnsent(getShowUnsent());
    window.addEventListener(PREFS_EVENT, sync);
    return () => window.removeEventListener(PREFS_EVENT, sync);
  }, []);
  // グループのメンバー一覧（@ で名前を選ぶときと、メンションを強調するときに使う）
  const [memberList, setMemberList] = useState<Member[]>([]);
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
  // 連打による二重送信を防ぐ（同じ内容を短時間に送らない）
  const lastSend = useRef<{ body: string; at: number }>({ body: "", at: 0 });
  const lastStamp = useRef<{ ref: string; at: number }>({ ref: "", at: 0 });
  const [leaving, setLeaving] = useState(false);
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
  const loadReaders = async (): Promise<void> => {
    try {
      const info = await api<{
        readBy: Reader[];
        members: Member[];
        friendship: FriendshipState | null;
        myLastReadAt: string | null;
      }>(`/api/dm/${conversationId}`);
      setReaders(info.readBy);
      setFriendship(info.friendship);
      setMemberList(info.members);
      // 送信者の名前・アイコンは保存しておく（今のメンバーの分を更新し、抜けた人の分も残す）
      const next = new Map(peopleRef.current);
      for (const m of info.members) {
        next.set(m.id, { name: m.displayName, hasAvatar: m.hasAvatar, avatarVersion: m.avatarVersion });
      }
      peopleRef.current = next;
      setPeople(next);
      savePeopleDb(conversationId, Object.fromEntries(next));
      // アイコンは版が変わったときだけ取りに行く（保存済みならサーバーに問い合わせない）
      rememberAvatars(info.members);
      void syncAvatars(info.members, { local: false });
      // 未読の区切りは、最初に開いたときの値を使う（あとの既読更新で動かさない）
      setUnreadFrom((current) => (current === undefined ? info.myLastReadAt : current));
    } catch {
      setUnreadFrom((current) => (current === undefined ? null : current));
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
    } finally {
      setLoaded(true);
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

  // 保存済みの送信者（名前・アイコン）を、通信より先に出す
  useEffect(() => {
    void loadPeopleDb(conversationId).then((stored) => {
      if (Object.keys(stored).length === 0) return;
      const merged = new Map<string, PersonInfo>([...Object.entries(stored), ...peopleRef.current]);
      peopleRef.current = merged;
      setPeople(merged);
    });
  }, [conversationId]);

  useEffect(() => {
    load();
    // 前回読んだ時刻を取ってから既読にする（未読の区切りを正しく出すため）
    void loadReaders().then(() => markRead());
    // IndexedDB に保存してある過去分を先に出す（最新は load() で取り直す）
    void loadMessagesDb(conversationId).then((stored) => {
      if (stored.length > 0) commit(mergeById(stored, messagesRef.current));
    });
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
        if (!peopleRef.current.has(event.message.senderId) && event.message.senderId !== meId) void loadReaders();
        if (event.message.senderId !== meId) markRead();
        onActivity();
        return;
      }
      if (event.type === "message_updated" && event.conversationId === conversationId) {
        patchMessage(event.id, (m) => ({ ...m, body: event.body, edited: true }));
        return;
      }
      // 管理者が削除したメッセージは、取り消しの表示も残さずに消す
      if (event.type === "message_removed" && event.conversationId === conversationId) {
        commit(messagesRef.current.filter((m) => m.id !== event.id));
        return;
      }
      if (event.type === "message_deleted" && event.conversationId === conversationId) {
        patchMessage(event.id, (m) => ({ ...m, deleted: true, body: null, imageUrl: null, reactions: [] }));
        return;
      }
      if (event.type === "reactions" && event.conversationId === conversationId) {
        patchMessage(event.messageId, (m) => ({ ...m, reactions: event.reactions }));
        return;
      }
      if (event.type === "poll" && event.conversationId === conversationId) {
        patchMessage(event.messageId, (m) => ({ ...m, poll: event.poll }));
        return;
      }
      if (event.type === "game" && event.conversationId === conversationId) {
        patchMessage(event.messageId, (m) => ({ ...m, game: event.game }));
      }
    });
  }, [conversationId]);

  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  // 新しいメッセージが増えたときだけ最下部へ。過去分の追加では動かさない
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (!initialPositioned.current) {
      if (!loaded || unreadFrom === undefined) return;
      initialPositioned.current = true;
      const line = document.getElementById("unread-line");
      if (line) {
        line.scrollIntoView({ block: "start" });
        return;
      }
    }
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, loaded, unreadFrom]);

  // 相手の入力中表示
  const [typingIds, setTypingIds] = useState<string[]>([]);
  const typingTimers = useRef(new Map<string, number>());
  const lastTypingSent = useRef(0);
  const noteTyping = (value: string) => {
    if (editing || !value.trim()) return;
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_GAP_MS) return;
    if (sendTyping(conversationId)) lastTypingSent.current = now;
  };

  useEffect(() => {
    const timers = typingTimers.current;
    const dropTyping = (userId: string) => {
      window.clearTimeout(timers.get(userId));
      timers.delete(userId);
      setTypingIds((current) => current.filter((id) => id !== userId));
    };
    setTypingIds([]);
    const off = onChatEvent((event) => {
      if (event.type === "typing" && event.conversationId === conversationId && event.userId !== meId) {
        const userId = event.userId;
        window.clearTimeout(timers.get(userId));
        timers.set(userId, window.setTimeout(() => dropTyping(userId), TYPING_HOLD_MS));
        setTypingIds((current) => (current.includes(userId) ? current : [...current, userId]));
        return;
      }
      // 相手のメッセージが届いたら、その人の入力中の表示はすぐ消す
      if (event.type === "message" && event.message.conversationId === conversationId) {
        dropTyping(event.message.senderId);
      }
    });
    return () => {
      off();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, [conversationId, meId]);

  // senninai とのトークでは、送信の確認待ちがあればモーダルで聞く（新しい発言のたびに確かめる）
  const botDm = !conversation?.isGroup && conversation?.otherId === SENNIN_BOT_ID;
  const [confirmSummary, setConfirmSummary] = useState<string | null>(null);
  useEffect(() => {
    if (!botDm) return;
    let alive = true;
    api<{ pending: { summary: string } | null }>("/api/senninai/pending")
      .then((r) => {
        if (alive) setConfirmSummary(r.pending?.summary ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [botDm, lastId]);

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
    } catch (err) {
      patchMessage(temp.id, (m) => ({ ...m, status: "failed" }));
      // サーバーが理由を返したとき（例: senninaiのコマンドの使い方）はその文を見せる
      setError(err instanceof Error && err.message ? err.message : "送信できませんでした。通信状態を確認してください。");
    }
  };

  const saveEdit = async (body: string) => {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/dm/messages/${editing.id}`, post({ body }));
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

  // スタンプを送る（画像とは別の種類。返信にも使える）
  // 戻るときは、画面を右へ滑らせてから前の画面へ戻る
  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(onBack, 220);
  };

  const sendStamp = async (stampRef: string) => {
    const now = Date.now();
    if (stampRef === lastStamp.current.ref && now - lastStamp.current.at < 600) return;
    lastStamp.current = { ref: stampRef, at: now };
    setStampOpen(false);
    if (editing) return;
    const replyId = replyTo?.id ?? null;
    setReplyTo(null);
    setError("");
    try {
      const message = await api<Message>(`/api/dm/${conversationId}/stamp`, post({ stampRef, replyToId: replyId }));
      upsert([message]);
      onActivity();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const enqueue = (body: string) => {
    const now = Date.now();
    if (body === lastSend.current.body && now - lastSend.current.at < 600) return;
    lastSend.current = { body, at: now };
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

  // 投票の選択（同じ選択肢をもう一度押すと取り消す）。結果は全員に届く
  const vote = async (messageId: string, optionIndex: number) => {
    try {
      await api(`/api/dm/messages/${messageId}/vote`, post({ optionIndex }));
      if (!isSocketOpen()) void load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  // 投票を締め切る（作った人だけ）。結果は全員に届く
  const closePoll = async (messageId: string) => {
    try {
      await api(`/api/dm/messages/${messageId}/poll/close`, post());
      if (!isSocketOpen()) void load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const sendPoll = async (poll: PollDraft) => {
    const replyId = replyTo?.id ?? null;
    const message = await api<Message>(`/api/dm/${conversationId}/poll`, post({ ...poll, replyToId: replyId }));
    setPollOpen(false);
    setReplyTo(null);
    upsert([message]);
    onActivity();
  };

  // ミニゲームを作る（グループのトークだけ）。募集がトークに出る
  const createGame = async (kind: GameKind) => {
    setGameOpen(false);
    setError("");
    try {
      const message = await api<Message>(`/api/dm/${conversationId}/game`, post({ kind }));
      upsert([message]);
      onActivity();
    } catch (err) {
      setError(errorText(err));
    }
  };

  // ミニゲームの操作（参加・開始・中止・プレイ）。結果は全員の画面に届く
  // 接続中は WebSocket で送る（サーバーのメモリで即座に処理され、全員へすぐ届く）。切断中は HTTP で送る
  // 成功なら true、できなかったら false（呼び出し側が結果を使えるように。例外は投げない）
  const gameAction = async (messageId: string, action: string, extra: Record<string, unknown> = {}): Promise<boolean> => {
    const payload = { action, ...extra };
    try {
      if (isSocketOpen()) {
        await sendGameAction(messageId, payload);
      } else {
        await api(`/api/dm/messages/${messageId}/game`, post(payload));
        void load();
      }
      return true;
    } catch (err) {
      // 連打・反射神経の操作は、タイミングが合わなかった分のエラーを出さない（画面の表示で分かるため）
      if (action !== "tap" && action !== "react") setError(err instanceof Error ? err.message : errorText(err));
      // 接続が切れた場合は、操作が届いたか分からないので、最新の状態を読み直す（楽観的な表示もここで元に戻る）
      void load();
      return false;
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
    // PDF やテキストはトークの中で開く。それ以外のファイルはダウンロード
    if (m.kind === "file" && m.fileUrl) return () => (viewerKindOf(m.fileName) ? setFileViewing(m) : downloadFile(m.fileUrl!, m.fileName));
    if (m.kind === "poll" && m.poll) return () => setPollViewingId(m.id);
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
  const otherId = isGroup ? null : conversation?.otherId ?? null;

  // 届いたフレンドリクエストを許可・拒否する
  const answerRequest = async (accept: boolean) => {
    if (!otherId) return;
    try {
      await api(`/api/friends/requests/${otherId}/${accept ? "accept" : "decline"}`, post());
      setFriendship(accept ? "friend" : "none");
      flash(accept ? "友だちになりました" : "リクエストを拒否しました");
    } catch (err) {
      flash(err instanceof ApiError ? err.message : "通信に失敗しました。");
    }
  };

  const menu = menuFor;
  const pollViewingMessage = pollViewingId ? messages.find((x) => x.id === pollViewingId) ?? null : null;
  const hasText = text.trim().length > 0;
  const byId = new Map(messages.map((m): [string, Message] => [m.id, m]));
  // 未読の区切り：開く前に読み終えていた時刻より後の、相手からのメッセージ
  const unreadTime = unreadFrom ? Date.parse(unreadFrom) : Number.NaN;
  const isUnread = (m: Message) =>
    !Number.isNaN(unreadTime) && !m.status && !m.deleted && m.kind !== "system" && m.senderId !== meId && Date.parse(m.createdAt) > unreadTime;
  const unreadCount = messages.filter(isUnread).length;
  const firstUnreadId = messages.find(isUnread)?.id ?? null;
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

  // @ の入力中（直前の「@名前」）なら、その名前に合うメンバーを候補に出す
  const mentionTyping = isGroup ? text.match(/(?:^|\s)@([a-z0-9_]{0,20})$/i)?.[1] ?? null : null;
  const mentionCandidates =
    mentionTyping === null
      ? []
      : memberList.filter(
          (m) =>
            m.id !== meId &&
            (m.username.startsWith(mentionTyping.toLowerCase()) || (mentionTyping !== "" && m.displayName.includes(mentionTyping)))
        );
  const pickMention = (username: string) => {
    setText((current) => current.replace(/(^|\s)@[a-z0-9_]{0,20}$/i, (_, space: string) => `${space}@${username} `));
    textRef.current?.focus();
  };
  const mentionable = new Set(memberList.map((m) => m.username.toLowerCase()));
  const memberNames = new Map(memberList.map((m): [string, string] => [m.id, m.displayName]));
  const meName = memberList.find((m) => m.id === meId)?.username.toLowerCase() ?? "";

  // トークの「電話に参加」から通話に入る
  const joinCallFromMessage = (callId: string) => {
    if (!conversation) return;
    const current = getCallState();
    if (current.status === "active" && current.callId === callId) return; // もう参加中
    if (current.status !== "idle") {
      setError("ほかの通話に参加中です。");
      return;
    }
    joinCallFromChat({ callId, conversationId, groupName: conversation.name }).catch((e) =>
      setError(e instanceof Error ? e.message : "通話に参加できませんでした")
    );
  };

  // グループ通話を始める（同じグループの全員に着信を送ります）
  const startGroupVoiceCall = () => {
    if (!conversation) return;
    const self = memberList.find((m) => m.id === meId);
    startGroupCall({
      conversationId,
      groupName: conversation.name,
      me: { id: meId, name: self?.displayName || self?.username || "", hasAvatar: self?.hasAvatar ?? false }
    }).catch((e) => setError(e instanceof Error ? e.message : "通話を始められませんでした"));
  };

  const typingNames = typingIds.map(
    (id) => memberList.find((m) => m.id === id)?.displayName ?? people.get(id)?.name ?? (isGroup ? "メンバー" : conversation?.name ?? "相手")
  );
  const typingLabel =
    typingNames.length === 0
      ? ""
      : typingNames.length === 1
        ? `${typingNames[0]}が入力中…`
        : `${typingNames[0]}ほか${typingNames.length - 1}人が入力中…`;

  return (
    <section className={`chat${leaving ? " is-leaving" : ""}`}>
      <header className="chat-head">
        <button className="icon-btn back-btn" onClick={leave} aria-label="戻る">
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
          <div className="head-actions">
            <button className="icon-btn call-btn" aria-label="グループ通話" onClick={startGroupVoiceCall}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
              </svg>
            </button>
            <button className="icon-btn" aria-label="グループ情報" onClick={() => setShowInfo(true)}>
              <Icon name="info" size={22} />
            </button>
          </div>
        )}
      </header>

      <div className="thread-area">
      {friendship === "incoming" && otherId && (
        <div className="friend-request" role="region" aria-label="フレンドリクエスト">
          <p>
            <strong>{conversation?.name ?? "相手"}</strong> さんからフレンドリクエストが届いています。友だちを許可しますか？
          </p>
          <div className="friend-request-actions">
            <button className="btn-small" onClick={() => void answerRequest(false)}>
              拒否
            </button>
            <button className="btn-small accent" onClick={() => void answerRequest(true)}>
              許可
            </button>
          </div>
        </div>
      )}
      {friendship === "outgoing" && (
        <p className="friend-request-note">フレンドリクエストを送信しました。相手が許可するまで友だちにはなりません。</p>
      )}

      <div className="thread" ref={threadRef}>
        {/* 最新まで読み込み終わるまでは、キャッシュの古い分も含めて骨組みだけを出す（途中のトークを見せてから切り替わらないように） */}
        {!loaded && <ThreadSkeleton />}
        {loaded && hasOlder && messages.length > 0 && (
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

        {(loaded ? messages : []).map((m, index) => {
          // 設定で非表示にしたときは、取り消されたメッセージを出さない
          if (m.deleted && !showUnsent) return null;
          const info = threadInfo(messages, index);
          const unreadLine =
            m.id === firstUnreadId ? (
              <div className="unread-line" id="unread-line">
                <span>ここから未読 {unreadCount > 0 ? `${unreadCount}件` : ""}</span>
              </div>
            ) : null;
          // グループのお知らせ（参加・退出・削除・名前の変更）は中央に小さく出す
          if (m.kind === "system") {
            return (
              <Fragment key={m.id}>
                {unreadLine}
                {info.divider && (
                  <div className="dm-divider">
                    <span>{info.divider}</span>
                  </div>
                )}
                <div className="system-notice" id={`msg-${m.id}`}>
                  {m.body}
                </div>
              </Fragment>
            );
          }
          const mine = m.senderId === meId;
          const replyTarget = m.replyToId ? byId.get(m.replyToId) : undefined;
          const showImage = m.kind === "image" && !m.deleted && m.imageUrl;
          const showStamp = m.kind === "stamp" && !m.deleted && Boolean(m.stampRef);
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
              {unreadLine}
              {info.divider && (
                <div className="dm-divider">
                  <span>{info.divider}</span>
                </div>
              )}
              <div className={rowClass} id={`msg-${m.id}`}>
                {!mine && (
                  <div className="msg-avatar">
                    {!info.joinPrev && avatarId && (
                      isGroup ? (
                        // グループでは相手のアイコンを押すと、その人のプロフィールを開く
                        <button
                          type="button"
                          className="avatar-tap"
                          aria-label={`${avatarName}のプロフィールを開く`}
                          onClick={() => navigate(`/profile/${avatarId}`)}
                        >
                          <Avatar userId={avatarId} hasAvatar={avatarHas} name={avatarName} size={36} />
                        </button>
                      ) : (
                        <Avatar userId={avatarId} hasAvatar={avatarHas} name={avatarName} size={36} />
                      )
                    )}
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
                      className={`bubble ${showImage ? "image" : ""} ${showStamp ? "stamp" : ""} ${m.kind === "poll" && m.poll && !m.deleted ? "poll" : ""} ${m.kind === "game" && !m.deleted ? "game" : ""} ${m.deleted ? "deleted" : ""} ${m.status ? "pending" : ""} ${hasStatus ? "has-status" : ""}`}
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
                      ) : m.kind === "stamp" && m.stampRef && stampUrlOf(m.stampRef) ? (
                        <img
                          className="stamp-img"
                          src={stampUrlOf(m.stampRef)!}
                          alt="スタンプ"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : m.kind === "stamp" ? (
                        // 画像が見つからない古いスタンプは、文字コードの名前を出さずに「スタンプ」と表示する
                        <p className="stamp-missing">{m.stampRef?.startsWith("builtin:") ? `スタンプ（${stampNameOf(m.stampRef)}）` : "スタンプ"}</p>
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
                            <small>
                            {formatSize(m.fileSize)}
                            {viewerKindOf(m.fileName) ? " ・ タップで表示" : ""}
                          </small>
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
                      ) : m.kind === "poll" && m.poll ? (
                        <PollCard poll={m.poll} onVote={(index) => void vote(m.id, index)} onOpen={() => setPollViewingId(m.id)} />
                      ) : m.kind === "call" && m.call ? (
                        <CallCard call={m.call} onJoin={() => joinCallFromMessage(m.call!.callId)} />
                      ) : m.kind === "game" ? (
                        m.game ? (
                          <GameCard game={m.game} names={memberNames} onAction={(action, extra) => gameAction(m.id, action, extra)} />
                        ) : (
                          <p className="game-loading">ミニゲームを読み込み中…</p>
                        )
                      ) : (
                        <p>
                          <CodeMessage text={m.body ?? ""} users={mentionable} meName={meName} />
                        </p>
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

      {mentionCandidates.length > 0 && (
        <ul className="mention-picker" aria-label="メンションする人">
          {mentionCandidates.slice(0, 8).map((m) => (
            <li key={m.id}>
              <button
                type="button"
                // 押しても入力欄のフォーカスを外さない（キーボードを閉じないため）
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(m.username)}
              >
                <Avatar userId={m.id} hasAvatar={m.hasAvatar} name={m.displayName} size={28} />
                <span className="mention-name">{m.displayName}</span>
                <small>@{m.username}</small>
              </button>
            </li>
          ))}
        </ul>
      )}

      {typingLabel && (
        <div className="muted small" role="status" aria-live="polite" style={{ padding: "2px 14px 0", minHeight: 18 }}>
          {typingLabel}
        </div>
      )}

      <form className="composer" ref={formRef} onSubmit={onSubmit}>
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
            onChange={(e) => {
              setText(e.target.value);
              noteTyping(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => {
              // キーボードが出きったあと、最新メッセージを入力欄の上に見せる
              window.setTimeout(() => bottomRef.current?.scrollIntoView({ block: "end" }), 350);
            }}
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
          <button type="button" className="composer-icon stamp" onClick={() => setStampOpen(true)} aria-label="スタンプを送る">
            <i className="fa-regular fa-face-smile" aria-hidden="true" />
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
          onLeft={leave}
          onChanged={onActivity}
        />
      )}
      {showRoom && conversation && !isGroup && (
        <RoomSettingsSheet
          conversation={conversation}
          onClose={() => setShowRoom(false)}
          onChanged={onActivity}
          onRemoved={() => {
            setShowRoom(false);
            onActivity();
            leave();
          }}
        />
      )}
      {stampOpen && <StampSheet onPick={(ref) => void sendStamp(ref)} onClose={() => setStampOpen(false)} />}
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
          onPoll={() => {
            setAttachOpen(false);
            setPollOpen(true);
          }}
          onGame={
            isGroup
              ? () => {
                  setAttachOpen(false);
                  setGameOpen(true);
                }
              : undefined
          }
        />
      )}
      {pollOpen && <PollSheet onSubmit={sendPoll} onClose={() => setPollOpen(false)} />}
      {pollViewingMessage?.poll && (
        <PollScreen
          poll={pollViewingMessage.poll}
          meId={meId}
          onVote={(index) => void vote(pollViewingMessage.id, index)}
          onClosePoll={() => void closePoll(pollViewingMessage.id)}
          onClose={() => setPollViewingId(null)}
        />
      )}
      {fileViewing?.fileUrl && (
        <FileViewer
          url={`${fileViewing.fileUrl}/view`}
          name={fileViewing.fileName ?? null}
          size={formatSize(fileViewing.fileSize)}
          onClose={() => setFileViewing(null)}
          onDownload={() => downloadFile(fileViewing.fileUrl!, fileViewing.fileName)}
        />
      )}
      {gameOpen && <GameSheet onPick={(kind) => void createGame(kind)} onClose={() => setGameOpen(false)} />}
      {contactOpen && (
        <ContactSheet
          meId={meId}
          onPick={(username) => void shareContact(username)}
          onClose={() => setContactOpen(false)}
        />
      )}
      {contactUser && <UserProfileSheet userId={contactUser.id} onClose={() => setContactUser(null)} />}
      {showProfile && conversation?.otherId && (
        <UserProfileSheet
          userId={conversation.otherId}
          onClose={() => setShowProfile(false)}
          onRoomSettings={() => {
            setShowProfile(false);
            setShowRoom(true);
          }}
        />
      )}
      {botDm && confirmSummary && <SenninaiConfirm summary={confirmSummary} onDone={() => setConfirmSummary(null)} />}
    </section>
  );
}
