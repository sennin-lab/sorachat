import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, ApiError } from "./api";
import { battleApi, type BattleMember } from "./battle";
import { BattleLobbySheet, BattleMatchingSheet, BattleWaitingSheet } from "./BattleSheets";
import { BattleSubscribeSheet } from "./BattleSubscription";
import { FriendSelectPage } from "./FriendSelectPage";
import { onBattleEvent, sendBattle } from "./realtime";
import type { Friend } from "./types";

// 拡張機能の中のオンライン対戦を、ソラチャットの画面側で進める仕組み（状態・相手探し・招待・中継）。
// 拡張機能の枠（iframe）からの依頼（battle-*）を受けて答え、相手からの知らせは枠へ渡す。
// サーバーとの通信・ソラチャットの画面の表示（相手探し・友だち選び・招待・開始）はすべてここで行う。

const CHANNEL = "sorachat-ext";
const MAX_PAYLOAD = 2048;

export type BattleReply = { ok: boolean; data?: unknown; code?: string; error?: string };

type Room = { roomId: string; status: "lobby" | "playing" };
type Waiter = { kind: "match"; resolve: (r: BattleReply) => void } | { kind: "invite"; roomId: string | null; resolve: (r: BattleReply) => void };
type Ui =
  | { kind: "matching"; size: number }
  | { kind: "friends"; friends: Friend[]; error: string; pick: (ids: string[] | null) => void }
  | { kind: "lobby"; roomId: string; members: BattleMember[]; busy: boolean; error: string }
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
    ? "相手が抜けたので、対戦が終わりました。"
    : reason === "host_left"
      ? "主催者が抜けたので、対戦が終わりました。"
      : reason === "timeout"
        ? "招待の期限が過ぎたので、対戦が終わりました。"
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
        case "started": {
          // 主催者の「開始」の返事で、もう受け取り済みなら重ねて渡さない
          if (roomId && roomRef.current?.roomId === roomId && roomRef.current.status === "playing") return;
          const info = { roomId, size: ev.size, seat: ev.seat, players: ev.players };
          roomRef.current = roomId ? { roomId, status: "playing" } : null;
          setUi(null);
          if (waiter && (waiter.kind === "match" || waiter.roomId === null || waiter.roomId === roomId)) {
            waiterRef.current = null;
            waiter.resolve({ ok: true, data: info });
            return;
          }
          postToFrame({ type: "started", ...info });
          return;
        }
        case "queue_expired": {
          if (waiter?.kind === "match") {
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
          if (waiter?.kind === "invite" && (waiter.roomId === roomId || waiter.roomId === null)) {
            waiterRef.current = null;
            waiter.resolve(fail("closed", closedText(reason)));
          }
          const current = uiRef.current;
          if (current && (current.kind === "lobby" || current.kind === "waiting") && current.roomId === roomId) setUi(null);
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
    if (waiter?.kind === "match") {
      await battleApi.cancelQueue(workId).catch(() => undefined);
    }
    if (room) {
      await battleApi.roomAction(room.roomId, "leave").catch(() => undefined);
    }
    waiter?.resolve(cancelled());
    return { ok: true };
  };

  // 相手を探す（ランダム）
  const findMatch = (size: number): Promise<BattleReply> => {
    if (roomRef.current || waiterRef.current) return Promise.resolve(fail("busy", "すでに対戦の中か、相手を探しています。"));
    return new Promise<BattleReply>((resolve) => {
      const waiter: Waiter = { kind: "match", resolve };
      waiterRef.current = waiter;
      setUi({ kind: "matching", size });
      runWithSubscription(() => battleApi.queue(workId, size))
        .then((result) => {
          if (waiterRef.current !== waiter) {
            // 探すのをやめたあとに、待ち行列へ入っていたら抜ける
            if (result.status === "waiting") void battleApi.cancelQueue(workId).catch(() => undefined);
            return;
          }
          if (result.status === "matched") {
            // 始まりの知らせ（WebSocket）を待つ。届かなかった場合は、部屋の番号だけで始める
            window.setTimeout(() => {
              if (waiterRef.current !== waiter) return;
              waiterRef.current = null;
              roomRef.current = { roomId: result.roomId, status: "playing" };
              setUi(null);
              resolve({ ok: true, data: { roomId: result.roomId, size, seat: null, players: [] } });
            }, 1500);
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

  // 友だちを招待する（1〜3人）。招待された人が承諾し、主催者が「開始」を押すと始まる
  const inviteFriends = async (): Promise<BattleReply> => {
    if (roomRef.current || waiterRef.current) return fail("busy", "すでに対戦の中か、相手を探しています。");
    try {
      const sub = await battleApi.subscription();
      if (!sub.subscribed && !sub.autoRenew) {
        const ok = await askSubscribe(`友だちとの対戦は、サブスクに入っている人が使えます（1週間 ${sub.price}pt）。`);
        if (!ok) return cancelled();
      }
      let notice = "";
      for (;;) {
        const friends = await api<Friend[]>("/api/friends");
        const ids = await new Promise<string[] | null>((pick) => setUi({ kind: "friends", friends, error: notice, pick }));
        if (!ids) {
          setUi(null);
          return cancelled();
        }
        try {
          const { room } = await runWithSubscription(() => battleApi.invite(workId, ids));
          const roomId = room.id;
          return await new Promise<BattleReply>((resolve) => {
            waiterRef.current = { kind: "invite", roomId, resolve };
            roomRef.current = { roomId, status: "lobby" };
            setUi({ kind: "lobby", roomId, members: room.members, busy: false, error: "" });
          });
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

  // 招待した側：開始する（承諾した人が2人以上）
  const startLobby = async () => {
    const current = uiRef.current;
    if (current?.kind !== "lobby") return;
    patchUi((u) => ({ ...u, busy: true, error: "" }));
    try {
      const { room } = await battleApi.roomAction(current.roomId, "start");
      const waiter = waiterRef.current;
      if (waiter?.kind === "invite" && waiter.roomId === current.roomId) {
        waiterRef.current = null;
        roomRef.current = { roomId: current.roomId, status: "playing" };
        setUi(null);
        waiter.resolve({ ok: true, data: { roomId: current.roomId, size: room?.size, seat: room?.seat, players: room?.players ?? [] } });
      }
    } catch (error) {
      patchUi((u) => ({ ...u, busy: false, error: error instanceof Error ? error.message : "開始できませんでした。" }));
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
      {ui.kind === "friends" && (
        <FriendSelectPage
          title="対戦に招待する友だち"
          friends={ui.friends}
          confirmLabel="招待"
          error={ui.error}
          emptyText="招待できる友だちがいません。先に友だちを追加してください。"
          onConfirm={(picked) => ui.pick(picked.map((f) => f.id))}
          onClose={() => ui.pick(null)}
        />
      )}
      {ui.kind === "lobby" && (
        <BattleLobbySheet members={ui.members} busy={ui.busy} error={ui.error} onStart={() => void startLobby()} onLeave={() => void leaveNow()} />
      )}
      {ui.kind === "waiting" && <BattleWaitingSheet hostName="" busy={ui.busy} onLeave={() => void leaveNow()} />}
      {ui.kind === "subscribe" && <BattleSubscribeSheet reason={ui.reason} onSubscribed={() => ui.done(true)} onClose={() => ui.done(false)} />}
    </>
  ) : null;

  return { request, frameLoaded, dispose, layer };
}
