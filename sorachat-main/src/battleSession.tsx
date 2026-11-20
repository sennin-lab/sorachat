import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ApiError } from "./api";
import { battleApi, READY_TIMEOUT_MS, type BattleCandidate, type BattleMember, type BattlePerson, type BattleReadyMember } from "./battle";
import { BattleLobbySheet, BattleMatchingSheet, BattlePickerPage, BattleReadySheet, BattleWaitingSheet } from "./BattleSheets";
import { BattleSubscribeSheet } from "./BattleSubscription";
import { onBattleEvent, sendBattle } from "./realtime";

// 拡張機能の中のオンライン対戦を、ソラチャットの画面側で進める仕組み（状態・相手探し・招待・準備OK・中継）。
// 拡張機能の枠（iframe）からの依頼（battle-*）を受けて答え、相手からの知らせは枠へ渡す。
// 流れ：相手を選ぶ →（招待なら承諾・開始）→ 全員の準備OK → 開始。準備OKがそろうまで、対戦は始まらない。

const CHANNEL = "sorachat-ext";
const MAX_PAYLOAD = 2048;

export type BattleReply = { ok: boolean; data?: unknown; code?: string; error?: string };

type Room = { roomId: string; status: "lobby" | "preparing" | "playing" };
// 相手を待つ依頼（相手が見つかって始まるまで、または招待の終わりまで）。roomId は、部屋が決まるまで null
type Waiter = { roomId: string | null; resolve: (r: BattleReply) => void };
type Choice = { random: true } | { ids: string[] };
type Ui =
  | { kind: "matching"; size: number }
  | { kind: "picker"; mode: "find" | "invite"; candidates: BattleCandidate[] | null; error: string; pick: (choice: Choice | null) => void }
  | { kind: "lobby"; roomId: string; members: BattleMember[]; busy: boolean; error: string }
  | { kind: "ready"; roomId: string; members: BattleReadyMember[]; readyUntil: number; ready: boolean; starting: boolean; busy: boolean; error: string }
  | { kind: "waiting"; roomId: string; busy: boolean }
  | { kind: "subscribe"; reason: string; done: (ok: boolean) => void };

const fail = (code: string, error: string): BattleReply => ({ ok: false, code, error });
const cancelled = () => fail("cancelled", "対戦をやめました。");

// 途中で利用者が取り消したときに使う（上の流れを抜ける）
class Cancelled extends Error {}

function errorReply(error: unknown): BattleReply {
  if (error instanceof Cancelled) return cancelled();
  if (error instanceof ApiError) return fail(error.code ?? "error", error.message);
  return fail("error", error instanceof Error ? error.message : "対戦できませんでした。");
}

const closedText = (reason: string) =>
  reason === "opponent_left"
    ? "相手が抜けたので、対戦が取り消されました。"
    : reason === "host_left"
      ? "主催者が抜けたので、対戦が終わりました。"
      : reason === "timeout"
        ? "招待の期限が過ぎたので、対戦が終わりました。"
        : reason === "ready_timeout"
          ? "準備OKが揃わなかったので、対戦を取り消しました。"
          : "対戦が終わりました。";

// 名前で1人の状態を変える（同じ名前が2人いても、最初の1人だけ変える）
function setMemberState(list: BattleMember[], name: string, state: BattleMember["state"]): BattleMember[] {
  const index = list.findIndex((m) => m.name === name && m.state !== state);
  if (index < 0) return list;
  return list.map((m, i) => (i === index ? { ...m, state } : m));
}

function removeInvited(list: BattleMember[], name: string): BattleMember[] {
  const index = list.findIndex((m) => m.name === name && m.state === "invited");
  return index < 0 ? list : list.filter((_, i) => i !== index);
}

// 準備OKになった人を、席の番号で印を付ける（同じ名前の人がいても区別できる。席が分からなければ名前で）
function markReady(list: BattleReadyMember[], seat: number | undefined, name: string): BattleReadyMember[] {
  if (typeof seat === "number") return list.map((m) => (m.seat === seat ? { ...m, ready: true } : m));
  const index = list.findIndex((m) => m.name === name && !m.ready);
  return index < 0 ? list : list.map((m, i) => (i === index ? { ...m, ready: true } : m));
}

export function useBattleSession({
  workId,
  joinRoomId,
  consented,
  frameRef
}: {
  workId: string;
  // 招待を受けて参加した部屋（開始を待っている状態で始まる）
  joinRoomId?: string;
  consented: boolean;
  frameRef: RefObject<HTMLIFrameElement>;
}) {
  const [ui, setUiState] = useState<Ui | null>(null);
  const uiRef = useRef<Ui | null>(null);
  const roomRef = useRef<Room | null>(joinRoomId ? { roomId: joinRoomId, status: "lobby" } : null);
  const waiterRef = useRef<Waiter | null>(null);
  const frameReadyRef = useRef(false);
  const queueRef = useRef<Record<string, unknown>[]>([]);

  const setUi = useCallback((next: Ui | null) => {
    uiRef.current = next;
    setUiState(next);
  }, []);

  const patchUi = useCallback(
    (change: (current: Ui) => Ui) => {
      const current = uiRef.current;
      if (current) setUi(change(current));
    },
    [setUi]
  );

  // 枠へ知らせを送る。枠の読み込みが終わるまでは、順番どおり溜めておく
  const postToFrame = useCallback(
    (payload: Record<string, unknown>) => {
      if (!frameReadyRef.current) {
        queueRef.current.push(payload);
        return;
      }
      frameRef.current?.contentWindow?.postMessage({ channel: CHANNEL, event: "battle", payload }, "*");
    },
    [frameRef]
  );

  // 枠の読み込みが終わったとき（溜めた知らせをまとめて渡す）
  const frameLoaded = useCallback(() => {
    frameReadyRef.current = true;
    for (const payload of queueRef.current.splice(0)) postToFrame(payload);
  }, [postToFrame]);

  // 相手からの知らせ（WebSocket）を、いまの状態に当てはめる
  useEffect(() => {
    return onBattleEvent((ev) => {
      if (ev.type !== "battle" || ev.gameId !== workId) return;
      const roomId = typeof ev.roomId === "string" ? ev.roomId : null;
      const waiter = waiterRef.current;
      const name = typeof ev.name === "string" ? ev.name : "";
      switch (ev.event) {
        case "prepare": {
          // 準備OKを求める（マッチングが決まった・主催者が開始した）。画面にはアイコン付きの名簿を出す
          const players = Array.isArray(ev.players) ? (ev.players as { seat: number; name: string }[]) : [];
          const people = Array.isArray(ev.people) ? (ev.people as BattlePerson[]) : null;
          const list: BattlePerson[] =
            people ?? players.map((p) => ({ seat: p.seat, userId: "", name: p.name, hasAvatar: false, avatarVersion: null }));
          const readyUntil = typeof ev.readyUntil === "number" ? ev.readyUntil : Date.now() + READY_TIMEOUT_MS;
          if (roomId) {
            roomRef.current = { roomId, status: "preparing" };
            if (waiter && waiter.roomId === null) waiter.roomId = roomId;
          }
          setUi({
            kind: "ready",
            roomId: roomId ?? "",
            members: list.map((p) => ({ ...p, ready: false })),
            readyUntil,
            ready: false,
            starting: false,
            busy: false,
            error: ""
          });
          postToFrame({ type: "prepare", roomId, players });
          return;
        }
        case "ready": {
          const readySeat = typeof ev.readySeat === "number" ? ev.readySeat : undefined;
          patchUi((u) => (u.kind === "ready" ? { ...u, members: markReady(u.members, readySeat, name) } : u));
          postToFrame({ type: "ready", name });
          return;
        }
        case "starting": {
          // 全員が準備OK：「開始中」を出す（2秒後に、知らせ「started」が届く）
          patchUi((u) => (u.kind === "ready" ? { ...u, starting: true } : u));
          return;
        }
        case "started": {
          // 主催者の「開始」の返事で、もう受け取り済みなら重ねて渡さない
          if (roomId && roomRef.current?.roomId === roomId && roomRef.current.status === "playing") return;
          const info = { roomId, size: ev.size, seat: ev.seat, players: ev.players };
          roomRef.current = roomId ? { roomId, status: "playing" } : null;
          setUi(null);
          if (waiter && (waiter.roomId === null || waiter.roomId === roomId)) {
            waiterRef.current = null;
            waiter.resolve({ ok: true, data: info });
            return;
          }
          postToFrame({ type: "started", ...info });
          return;
        }
        case "queue_expired": {
          if (waiter && waiter.roomId === null) {
            waiterRef.current = null;
            setUi(null);
            waiter.resolve(fail("expired", "相手が見つからなかったので、探すのをやめました。もう一度お試しください。"));
          }
          return;
        }
        case "joined": {
          patchUi((u) => (u.kind === "lobby" ? { ...u, members: setMemberState(u.members, name, "joined") } : u));
          postToFrame({ type: "joined", name });
          return;
        }
        case "declined": {
          patchUi((u) => (u.kind === "lobby" ? { ...u, members: removeInvited(u.members, name) } : u));
          postToFrame({ type: "declined", name });
          return;
        }
        case "invite_closed": {
          postToFrame({ type: "unselected" });
          return;
        }
        case "left": {
          patchUi((u) => (u.kind === "lobby" ? { ...u, members: removeInvited(u.members, name) } : u));
          postToFrame({ type: "left", name, leftSeat: ev.leftSeat });
          return;
        }
        case "closed": {
          const reason = typeof ev.reason === "string" ? ev.reason : "";
          if (roomRef.current?.roomId === roomId) roomRef.current = null;
          // 準備中・招待中に取り消されたら、待っている依頼を終える（マッチングは成立しない）
          if (waiter && (waiter.roomId === roomId || waiter.roomId === null)) {
            waiterRef.current = null;
            waiter.resolve(fail("closed", closedText(reason)));
          }
          const current = uiRef.current;
          if (current && (current.kind === "lobby" || current.kind === "waiting" || current.kind === "ready") && current.roomId === roomId) {
            setUi(null);
          }
          postToFrame({ type: "closed", reason });
          return;
        }
        case "message": {
          postToFrame({ type: "message", from: ev.from, payload: ev.payload });
          return;
        }
        case "error": {
          postToFrame({ type: "error", error: ev.error });
          return;
        }
        default:
          return;
      }
    });
  }, [workId, setUi, patchUi, postToFrame]);

  // 招待で参加した部屋：同意が済んだら、開始を待つ画面を出す（知らせは枠へも送る）
  useEffect(() => {
    if (!consented || !joinRoomId || uiRef.current) return;
    if (roomRef.current?.roomId !== joinRoomId || roomRef.current.status !== "lobby") return;
    setUi({ kind: "waiting", roomId: joinRoomId, busy: false });
    postToFrame({ type: "waiting", roomId: joinRoomId });
  }, [consented, joinRoomId, setUi, postToFrame]);

  // サブスクの案内を出し、入れたら true（やめたら false）。終わったら、前の画面に戻す
  const askSubscribe = (reason: string) =>
    new Promise<boolean>((resolve) => {
      const previous = uiRef.current;
      setUi({
        kind: "subscribe",
        reason,
        done: (ok) => {
          setUi(previous);
          resolve(ok);
        }
      });
    });

  // 依頼を送る。サブスクが切れていると分かったら案内を出し、入ったらもう一度送る
  const runWithSubscription = async <T,>(task: () => Promise<T>): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "not_subscribed") throw error;
      const ok = await askSubscribe(error.message);
      if (!ok) throw new Cancelled("cancelled");
      return task();
    }
  };

  // 進行中の対戦・相手探しを、すべてやめる（相手には退出が届く）
  const leaveNow = async (): Promise<BattleReply> => {
    const room = roomRef.current;
    const waiter = waiterRef.current;
    if (!room && !waiter) {
      setUi(null);
      return fail("not_in_room", "対戦の中ではありません。");
    }
    waiterRef.current = null;
    roomRef.current = null;
    setUi(null);
    if (waiter && waiter.roomId === null) {
      await battleApi.cancelQueue(workId).catch(() => undefined);
    }
    if (room) {
      await battleApi.roomAction(room.roomId, "leave").catch(() => undefined);
    }
    waiter?.resolve(cancelled());
    return { ok: true };
  };

  // 相手を選ぶ画面を出し、選ばれるまで待つ（ランダム・友だちの招待・やめる）
  // 押したらすぐ選ぶ画面を出し（読み込み中のアニメーション）、友だちの一覧が届いたら入れる
  const pickOpponent = (mode: "find" | "invite", error: string): Promise<Choice | null> =>
    new Promise<Choice | null>((resolve, reject) => {
      const pick = (choice: Choice | null) => {
        setUi(null);
        resolve(choice);
      };
      setUi({ kind: "picker", mode, candidates: null, error, pick });
      battleApi
        .candidates(workId)
        .then((candidates) => {
          patchUi((u) => (u.kind === "picker" && u.pick === pick ? { ...u, candidates } : u));
        })
        .catch((e) => {
          const current = uiRef.current;
          if (current?.kind === "picker" && current.pick === pick) setUi(null);
          reject(e);
        });
    });

  // ランダムに相手を探す（人数がそろったら、準備OKの画面へ。全員が準備OKを押すと始まる）
  const randomMatch = (size: number): Promise<BattleReply> => {
    return new Promise<BattleReply>((resolve) => {
      const waiter: Waiter = { roomId: null, resolve };
      waiterRef.current = waiter;
      setUi({ kind: "matching", size });
      runWithSubscription(() => battleApi.queue(workId, size))
        .then((result) => {
          if (waiterRef.current !== waiter) {
            // 探すのをやめたあとに、待ち行列へ入っていたら抜ける
            if (result.status === "waiting") void battleApi.cancelQueue(workId).catch(() => undefined);
            return;
          }
          // 相手が見つかった知らせ（WebSocket の prepare）が先に届いていなければ、部屋の番号だけで準備OKの画面を出す
          if (result.status === "matched" && !roomRef.current) {
            waiter.roomId = result.roomId;
            roomRef.current = { roomId: result.roomId, status: "preparing" };
            setUi({ kind: "ready", roomId: result.roomId, members: [], readyUntil: Date.now() + READY_TIMEOUT_MS, ready: false, starting: false, busy: false, error: "" });
          }
        })
        .catch((error) => {
          if (waiterRef.current !== waiter) return;
          waiterRef.current = null;
          setUi(null);
          resolve(errorReply(error));
        });
    });
  };

  // 友だちを招待する。承諾が2人以上そろったら、主催者が開始を押す（そのあと全員の準備OK）
  const inviteIds = async (ids: string[]): Promise<BattleReply> => {
    const { room } = await runWithSubscription(() => battleApi.invite(workId, ids));
    return new Promise<BattleReply>((resolve) => {
      waiterRef.current = { roomId: room.id, resolve };
      roomRef.current = { roomId: room.id, status: "lobby" };
      setUi({ kind: "lobby", roomId: room.id, members: room.members, busy: false, error: "" });
    });
  };

  // 相手を選んで始める（マッチングでも友だちとの対戦でも、ここを通る）
  const matchFlow = async (mode: "find" | "invite", size: number): Promise<BattleReply> => {
    try {
      // 対戦は、サブスクに入っている必要がある（切れていれば、先に案内する）
      const sub = await battleApi.subscription();
      if (!sub.subscribed && !sub.autoRenew) {
        const ok = await askSubscribe(`対戦は、サブスクに入っている人が使えます（1週間 ${sub.price}pt）。`);
        if (!ok) return cancelled();
      }
      // ランダムは、友だち選択を挟まず、そのまま待機モーダル（相手を探しています）を出す
      if (mode === "find") return await randomMatch(size);
      let notice = "";
      for (;;) {
        const choice = await pickOpponent(mode, notice);
        if (!choice) return cancelled();
        if ("random" in choice) return await randomMatch(size);
        try {
          return await inviteIds(choice.ids);
        } catch (error) {
          // 招待できない友だちがいたら、理由を見せて選び直してもらう
          if (error instanceof ApiError && error.code === "invitee_unavailable") {
            notice = error.message;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      setUi(null);
      return errorReply(error);
    }
  };

  // 相手を探す（依頼）：ランダム、または友だちを選んで招待
  const findMatch = (size: number): Promise<BattleReply> => {
    if (roomRef.current || waiterRef.current) return Promise.resolve(fail("busy", "すでに対戦の中か、相手を探しています。"));
    return matchFlow("find", size);
  };

  // 友だちを招待する（依頼）
  const inviteFriends = (): Promise<BattleReply> => {
    if (roomRef.current || waiterRef.current) return Promise.resolve(fail("busy", "すでに対戦の中か、相手を探しています。"));
    return matchFlow("invite", 2);
  };

  // 招待した側：開始する（承諾した人が2人以上）。すぐには始まらず、全員の準備OKを待つ
  const startLobby = async () => {
    const current = uiRef.current;
    if (current?.kind !== "lobby") return;
    patchUi((u) => ({ ...u, busy: true, error: "" }));
    try {
      const { room } = await battleApi.roomAction(current.roomId, "start");
      // 準備OKの画面は、知らせ「prepare」（アイコン付きの名簿）で出す。ここでは押せる状態に戻すだけ
      if (room?.status === "preparing") patchUi((u) => (u.kind === "lobby" ? { ...u, busy: false } : u));
    } catch (error) {
      patchUi((u) => ({ ...u, busy: false, error: error instanceof Error ? error.message : "開始できませんでした。" }));
    }
  };

  // 準備OKを押す（全員がそろうと、対戦が始まる）
  const pressReady = async () => {
    const current = uiRef.current;
    if (current?.kind !== "ready" || !current.roomId) return;
    patchUi((u) => ({ ...u, busy: true, error: "" }));
    try {
      await battleApi.roomAction(current.roomId, "ready");
      patchUi((u) => (u.kind === "ready" ? { ...u, busy: false, ready: true } : u));
    } catch (error) {
      patchUi((u) => ({ ...u, busy: false, error: error instanceof Error ? error.message : "準備OKを送れませんでした。" }));
    }
  };

  // 枠からの、対戦の中のデータの送信（相手へ中継される）
  const sendData = (payload: unknown): BattleReply => {
    const room = roomRef.current;
    if (!room || room.status !== "playing") return fail("not_playing", "対戦中ではありません。");
    let json = "";
    try {
      json = JSON.stringify(payload) ?? "";
    } catch {
      json = "";
    }
    if (!json) return fail("invalid", "送るデータを読み取れませんでした。");
    if (json.length > MAX_PAYLOAD) return fail("invalid", `1回に送れるのは ${MAX_PAYLOAD} 文字までです。`);
    return sendBattle(room.roomId, payload) ? { ok: true } : fail("offline", "接続されていません。少し待ってからお試しください。");
  };

  // 枠からの依頼（battle-*）。対戦の依頼でなければ null を返す
  const request = async (type: string, data: Record<string, unknown>): Promise<BattleReply | null> => {
    switch (type) {
      case "battle-status":
        try {
          return { ok: true, data: await battleApi.subscription() };
        } catch (error) {
          return errorReply(error);
        }
      case "battle-find":
        return findMatch(typeof data.size === "number" ? data.size : 2);
      case "battle-invite":
        return inviteFriends();
      case "battle-cancel":
        return leaveNow();
      case "battle-leave":
        return leaveNow();
      case "battle-send":
        return sendData(data.payload);
      default:
        return null;
    }
  };

  // 閉じるとき：対戦・相手探しを終わらせる（確認の画面は出さない）
  const dispose = () => {
    void leaveNow();
  };

  const layer = ui ? (
    <>
      {ui.kind === "matching" && <BattleMatchingSheet size={ui.size} onCancel={() => void leaveNow()} />}
      {ui.kind === "picker" && (
        <BattlePickerPage mode={ui.mode} candidates={ui.candidates} error={ui.error} onPick={(choice) => ui.pick(choice)} onClose={() => ui.pick(null)} />
      )}
      {ui.kind === "lobby" && (
        <BattleLobbySheet members={ui.members} busy={ui.busy} error={ui.error} onStart={() => void startLobby()} onLeave={() => void leaveNow()} />
      )}
      {ui.kind === "ready" && (
        <BattleReadySheet
          members={ui.members}
          readyUntil={ui.readyUntil}
          ready={ui.ready}
          starting={ui.starting}
          busy={ui.busy}
          error={ui.error}
          onReady={() => void pressReady()}
          onLeave={() => void leaveNow()}
        />
      )}
      {ui.kind === "waiting" && <BattleWaitingSheet hostName="" busy={ui.busy} onLeave={() => void leaveNow()} />}
      {ui.kind === "subscribe" && <BattleSubscribeSheet reason={ui.reason} onSubscribed={() => ui.done(true)} onClose={() => ui.done(false)} />}
    </>
  ) : null;

  return { request, frameLoaded, dispose, layer };
}
