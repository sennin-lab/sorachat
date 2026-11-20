import "./env.ts";
// オンライン対戦：サブスクの期限・依頼の検査・ランダムの対戦・友だちの招待・中継・退出・掃除を確かめる。
// 実際のSupabase・WebSocketには接続しない（通知は配列に集める）。
import assert from "node:assert/strict";
import { BATTLE, autoRenewRequestId, checkAutoRenewRequest, checkInviteRequest, checkPayload, checkSize, checkSubscribeRequest, extendedExpiry, isSubscribed } from "../server/battleRules.ts";
import {
  cancelQueue,
  createLobby,
  enqueueRandom,
  isBusy,
  leaveRoom,
  pendingInvitesOf,
  pruneBattles,
  readyUp,
  relay,
  resetBattlesForTest,
  respondInvite,
  roomIdOf,
  roomView,
  setBattleNotifier,
  startLobby,
  userOffline,
  userOnline
} from "../server/battleRooms.ts";
import { buildExtensionDocument, EXT_BRIDGE } from "../server/studioRules.ts";

type Sent = { userId: string; payload: Record<string, unknown> };
// 全員が準備OKになってから「開始中」の2秒が過ぎるまで待つ
const waitStart = () => new Promise((resolve) => setTimeout(resolve, BATTLE.startDelayMs + 60));
let sent: Sent[] = [];
setBattleNotifier((userId, payload) => sent.push({ userId, payload }));
const take = (userId: string) => sent.filter((s) => s.userId === userId).map((s) => s.payload);
const reset = () => {
  sent = [];
  resetBattlesForTest();
};

// ---- サブスクの期限 ----
const day = 24 * 60 * 60_000;
const now = new Date("2026-11-13T00:00:00Z");
assert.equal(BATTLE.subscriptionPoints, 200);
assert.equal(BATTLE.subscriptionDays, 7);
assert.equal(isSubscribed(null, now), false);
assert.equal(isSubscribed(new Date(now.getTime() + 1), now), true);
assert.equal(isSubscribed(now, now), false, "期限ちょうどは切れた扱い");
// 切れていれば今から7日、有効中なら今の期限に7日を足す（切れた分の日数は貯まらない）
assert.equal(extendedExpiry(null, now).getTime(), now.getTime() + 7 * day);
assert.equal(extendedExpiry(new Date(now.getTime() - 30 * day), now).getTime(), now.getTime() + 7 * day);
assert.equal(extendedExpiry(new Date(now.getTime() + 2 * day), now).getTime(), now.getTime() + 9 * day);
assert.match(autoRenewRequestId(new Date(12345)), /^auto-12345$/);
assert.match(autoRenewRequestId(null), /^auto-0$/);

// ---- 依頼の検査 ----
assert.equal(checkSubscribeRequest({ requestId: "sub-0001abcd" }).ok, true);
assert.equal(checkSubscribeRequest({ requestId: "short" }).ok, false);
assert.equal(checkSubscribeRequest({ requestId: "has space here" }).ok, false);
assert.equal(checkSubscribeRequest(null).ok, false);
assert.equal(checkAutoRenewRequest({ autoRenew: false }).ok, true);
assert.equal(checkAutoRenewRequest({ autoRenew: "yes" }).ok, false);
assert.equal(checkSize(undefined).ok && checkSize(undefined).size, 2, "省略時は2人");
assert.equal(checkSize(4).ok, true);
assert.equal(checkSize(1).ok, false);
assert.equal(checkSize(5).ok, false);
assert.equal(checkSize(2.5).ok, false);
assert.equal(checkInviteRequest({ inviteIds: ["a", "a"] }).ok && checkInviteRequest({ inviteIds: ["a", "a"] }).inviteIds.length, 1, "重複は1人にまとめる");
assert.equal(checkInviteRequest({ inviteIds: [] }).ok, false);
assert.equal(checkInviteRequest({ inviteIds: ["a", "b", "c", "d"] }).ok, false, "招待は最大3人");
assert.equal(checkInviteRequest({ inviteIds: [1] }).ok, false);
assert.equal(checkPayload({ hand: "rock" }).ok, true);
assert.equal(checkPayload(undefined).ok, false);
assert.equal(checkPayload("x".repeat(BATTLE.messageMaxBytes)).ok, false, "大きすぎるデータは送れない");
const circular: Record<string, unknown> = {};
circular.self = circular;
assert.equal(checkPayload(circular).ok, false, "循環する値は送れない");

// ---- ランダムの対戦 ----
reset();
{
  const a = enqueueRandom({ userId: "u-a", name: "あいこ", gameId: "g-1", gameName: "じゃんけん", size: 2 });
  assert.deepEqual(a, { status: "waiting" });
  assert.equal(isBusy("u-a"), true, "待っている人は、ほかの対戦に入れない");
  assert.throws(() => enqueueRandom({ userId: "u-a", name: "あいこ", gameId: "g-1", gameName: "じゃんけん", size: 2 }), /すでに/);
  // 人数が違う・拡張機能が違うなら、組まない
  assert.deepEqual(enqueueRandom({ userId: "u-x", name: "x", gameId: "g-2", gameName: "別", size: 2 }), { status: "waiting" });
  assert.deepEqual(enqueueRandom({ userId: "u-y", name: "y", gameId: "g-1", gameName: "じゃんけん", size: 3 }), { status: "waiting" });
  // 同じ条件の2人目で、部屋ができる
  const b = enqueueRandom({ userId: "u-b", name: "ぼたん", gameId: "g-1", gameName: "じゃんけん", size: 2 });
  assert.equal(b.status, "matched");
  const roomId = (b as { roomId: string }).roomId;
  assert.equal(roomIdOf("u-a"), roomId);
  assert.equal(roomIdOf("u-b"), roomId);
  // まだ始まらない：2人とも「準備OK」を求められる
  const prepareA = take("u-a").find((p) => p.event === "prepare");
  assert.ok(prepareA && take("u-b").some((p) => p.event === "prepare"), "2人とも準備OKを求められる");
  assert.equal(take("u-a").some((p) => p.event === "started"), false, "準備OKがそろうまで始まらない");
  assert.equal(roomView("u-a", roomId)!.status, "preparing");
  assert.deepEqual(prepareA!.players, [{ seat: 0, name: "あいこ" }, { seat: 1, name: "ぼたん" }]);
  // 拡張機能へ渡す名簿（players）には、相手の ID を入れない。画面用の people には、アイコンのためにIDを入れる
  assert.equal(JSON.stringify(prepareA!.players).includes("u-b"), false);
  assert.ok(Array.isArray(prepareA!.people) && (prepareA!.people as { userId: string }[]).some((p) => p.userId === "u-b"), "画面用の名簿にアイコンの持ち主が入る");
  readyUp("u-a", roomId);
  assert.equal(take("u-b").some((p) => p.event === "started"), false, "1人だけでは始まらない");
  readyUp("u-b", roomId);
  // 全員そろったら「開始中」を知らせ、2秒後に始まる
  assert.equal(roomView("u-a", roomId)!.status, "starting");
  assert.ok(take("u-a").some((p) => p.event === "starting"), "開始中を知らせる");
  assert.equal(take("u-a").some((p) => p.event === "started"), false, "開始中の間はまだ始まらない");
  await waitStart();
  const startedA = take("u-a").find((p) => p.event === "started");
  const startedB = take("u-b").find((p) => p.event === "started");
  assert.ok(startedA && startedB, "全員が準備OKで、2人とも始まりを知らされる");
  assert.equal(startedA!.seat, 0);
  assert.equal(startedB!.seat, 1);
  assert.deepEqual(startedA!.players, [{ seat: 0, name: "あいこ" }, { seat: 1, name: "ぼたん" }]);
  assert.equal(JSON.stringify(startedA).includes("u-b"), false);
  // 待ち行列の残りは、まだ組まれていない
  assert.equal(isBusy("u-x"), true);
  assert.equal(cancelQueue("u-x"), true);
  assert.equal(isBusy("u-x"), false);
}

// ---- 友だちの招待（承諾・断る・開始・中継・退出） ----
reset();
{
  const room = createLobby({
    hostId: "h",
    hostName: "ホスト",
    gameId: "g-9",
    gameName: "すごろく",
    invitees: [
      { userId: "f1", name: "友だち1" },
      { userId: "f2", name: "友だち2" },
      { userId: "f3", name: "友だち3" }
    ]
  });
  assert.equal(room.size, 4);
  for (const f of ["f1", "f2", "f3"]) {
    const invite = take(f).find((p) => p.type === "battle-invite");
    assert.ok(invite, `${f} に招待が届く`);
    assert.equal(invite!.roomId, room.id);
    assert.equal(invite!.hostName, "ホスト");
  }
  // 招待された人は、承諾するまで部屋の中ではない
  assert.equal(roomIdOf("f1"), null);
  // 開始は、承諾が2人未満なら断られる（主催者だけ・待機中だけ）
  assert.throws(() => startLobby("h", room.id), /もう1人以上/);
  respondInvite("f1", room.id, true);
  assert.ok(take("h").some((p) => p.event === "joined" && p.name === "友だち1"), "主催者に承諾が届く");
  respondInvite("f2", room.id, false);
  assert.ok(take("h").some((p) => p.event === "declined" && p.name === "友だち2"), "断ったことが主催者に届く");
  // 断った人は、もう入れない
  assert.throws(() => respondInvite("f2", room.id, true), /この招待は見つかりません/);
  // 承諾していない人（f3）は、開始のときに外される
  assert.throws(() => startLobby("f1", room.id), /見つかりません/, "主催者以外は開始できない");
  startLobby("h", room.id);
  assert.equal(roomView("h", room.id)!.status, "preparing", "開始では、まだ準備OKを待つ");
  assert.equal(take("h").some((p) => p.event === "started"), false);
  assert.ok(take("f1").some((p) => p.event === "prepare"), "承諾した人にも準備OKを求める");
  readyUp("f1", room.id);
  assert.equal(take("h").some((p) => p.event === "started"), false, "主催者が準備OKを押すまで始まらない");
  readyUp("h", room.id);
  assert.equal(roomView("h", room.id)!.status, "starting", "全員そろったら開始中");
  await waitStart();
  assert.equal(roomView("h", room.id)!.status, "playing");
  const startedF1 = take("f1").find((p) => p.event === "started");
  assert.ok(startedF1, "承諾した人に開始が届く");
  assert.equal(startedF1!.seat, 1);
  assert.ok(take("f3").some((p) => p.event === "invite_closed"), "外された人には招待の終わりが届く");
  assert.equal(take("f3").some((p) => p.event === "started"), false);

  // 中継：相手（席1）から主催者（席0）へ。部屋の外の人は送れない
  relay("f1", room.id, { move: 3 });
  const msg = take("h").find((p) => p.event === "message");
  assert.ok(msg, "主催者に相手のデータが届く");
  assert.equal(msg!.from, 1);
  assert.deepEqual(msg!.payload, { move: 3 });
  assert.equal(take("f1").some((p) => p.event === "message"), false, "送った本人には戻らない");
  assert.throws(() => relay("f3", room.id, {}), /参加していません/);

  // 2人のうち1人が抜ければ、部屋は閉じる
  leaveRoom("f1", room.id);
  assert.equal(roomView("h", room.id)!.status, "closed");
  assert.ok(take("h").some((p) => p.event === "closed" && p.reason === "opponent_left"));
  assert.equal(isBusy("h"), false, "閉じた部屋からは抜ける");
}

// 主催者が待機中に抜けると、部屋は閉じて全員に届く
reset();
{
  const room = createLobby({ hostId: "h2", hostName: "ホスト2", gameId: "g-9", gameName: "すごろく", invitees: [{ userId: "f4", name: "友だち4" }] });
  respondInvite("f4", room.id, true);
  leaveRoom("h2", room.id);
  assert.ok(take("f4").some((p) => p.event === "closed" && p.reason === "host_left"));
  assert.equal(roomView("f4", room.id)!.status, "closed");
}

// 招待された人が、承諾前に招待の部屋を見ても、ほかの人の情報は見えない（名前の一覧だけ）
reset();
{
  const room = createLobby({ hostId: "h3", hostName: "ホスト3", gameId: "g-3", gameName: "x", invitees: [{ userId: "f5", name: "f5名" }] });
  const view = roomView("f5", room.id)!;
  assert.equal(view.isHost, false);
  assert.equal(JSON.stringify(view).includes("h3"), false, "ID は含まない");
}

// ---- 掃除（待ちの期限・招待の期限・終わった部屋） ----
reset();
{
  enqueueRandom({ userId: "old", name: "古い", gameId: "g-z", gameName: "z", size: 2 });
  const room = createLobby({ hostId: "h4", hostName: "h4", gameId: "g-z", gameName: "z", invitees: [{ userId: "f6", name: "f6" }] });
  pruneBattles(Date.now() + BATTLE.queueTtlMs + 1);
  assert.equal(isBusy("old"), false, "古い待ちは消える");
  assert.ok(take("old").some((p) => p.event === "queue_expired"));
  pruneBattles(Date.now() + BATTLE.lobbyTtlMs + 1);
  assert.equal(roomView("h4", room.id)!.status, "closed");
  assert.ok(take("f6").some((p) => p.event === "closed" && p.reason === "timeout"));
}

// ---- 接続の切れ（猶予の中で戻れば続けられる） ----
reset();
{
  enqueueRandom({ userId: "p1", name: "p1", gameId: "g-w", gameName: "w", size: 2 });
  const matched = enqueueRandom({ userId: "p2", name: "p2", gameId: "g-w", gameName: "w", size: 2 });
  const roomId = (matched as { roomId: string }).roomId;
  readyUp("p1", roomId);
  readyUp("p2", roomId);
  await waitStart();
  userOffline("p1");
  userOnline("p1");
  relay("p2", roomId, { still: "here" });
  assert.equal(roomView("p1", roomId)!.status, "playing", "戻れば対戦は続く");
  assert.ok(take("p1").some((p) => p.event === "message"));
}

// ---- 準備OK：全員がそろうまで始まらない。時間切れ・途中で抜けたら取り消す ----
reset();
{
  enqueueRandom({ userId: "r1", name: "r1", gameId: "g-r", gameName: "r", size: 2 });
  const matched = enqueueRandom({ userId: "r2", name: "r2", gameId: "g-r", gameName: "r", size: 2 });
  const roomId = (matched as { roomId: string }).roomId;
  assert.throws(() => readyUp("zz", roomId), /参加していません/, "部屋にいない人は準備OKを押せない");
  readyUp("r1", roomId);
  readyUp("r1", roomId);
  assert.equal(take("r2").some((p) => p.event === "started"), false);
  pruneBattles(Date.now() + BATTLE.readyTimeoutMs + 1);
  assert.equal(roomView("r1", roomId)!.status, "closed");
  assert.ok(take("r2").some((p) => p.event === "closed" && p.reason === "ready_timeout"), "時間切れは全員に届く");
  assert.equal(isBusy("r1"), false, "取り消されたら、また探せる");
  assert.throws(() => readyUp("r2", roomId), /準備OK/, "閉じた部屋では準備OKを押せない");
}

// 準備中に1人が抜けると、マッチングは成立させず取り消す
reset();
{
  enqueueRandom({ userId: "r3", name: "r3", gameId: "g-r", gameName: "r", size: 2 });
  const matched = enqueueRandom({ userId: "r4", name: "r4", gameId: "g-r", gameName: "r", size: 2 });
  const roomId = (matched as { roomId: string }).roomId;
  leaveRoom("r4", roomId);
  assert.equal(roomView("r3", roomId)!.status, "closed");
  assert.ok(take("r3").some((p) => p.event === "closed" && p.reason === "opponent_left"));
  assert.equal(isBusy("r3"), false);
}

// 開始中（2秒）に抜けたら、始まらずに取り消す
reset();
{
  enqueueRandom({ userId: "s1", name: "s1", gameId: "g-s", gameName: "s", size: 2 });
  const matched = enqueueRandom({ userId: "s2", name: "s2", gameId: "g-s", gameName: "s", size: 2 });
  const roomId = (matched as { roomId: string }).roomId;
  readyUp("s1", roomId);
  readyUp("s2", roomId);
  assert.equal(roomView("s1", roomId)!.status, "starting");
  leaveRoom("s2", roomId);
  await waitStart();
  assert.equal(roomView("s1", roomId)!.status, "closed", "開始中に抜けたら始まらない");
  assert.equal(take("s1").some((p) => p.event === "started"), false);
}

// 閉じていた間の招待は、接続し直したときに出せる（承諾すると、もう招待ではない）
reset();
{
  const room = createLobby({ hostId: "hp", hostName: "ホストP", gameId: "g-p", gameName: "パズル", invitees: [{ userId: "fp", name: "fp名" }] });
  const pending = pendingInvitesOf("fp");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].roomId, room.id);
  assert.equal(pending[0].hostName, "ホストP");
  respondInvite("fp", room.id, true);
  assert.equal(pendingInvitesOf("fp").length, 0, "承諾したら、もう招待ではない");
}

// ---- 拡張機能の文書：対戦の窓口が入り、ブリッジの構文が正しい ----
const doc = buildExtensionDocument({ html: "<p>x</p>", css: "", js: "window.__battle = 1;" });
const scripts = [...doc.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
for (const code of scripts) assert.doesNotThrow(() => new Function(code), "スクリプトの構文が正しい");
assert.ok(doc.includes("battle"), "対戦の窓口が文書に入っている");
assert.ok(doc.includes("battle-find"), "対戦の依頼の名前が入っている");
assert.equal(EXT_BRIDGE.version, 3);
assert.ok(EXT_BRIDGE.battleTimeoutMs >= 60_000, "相手を待つ時間は長め");

console.log("battle tests: all passed");
