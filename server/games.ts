// ミニゲームの保存・操作・配信。進行の中身は gameLogic.ts にある。
// 1つのゲームは「game」のメッセージ1件に紐づく（sc_games.message_id）。
//
// 【しくみ】
// ・進行中のゲームはアプリのサーバーのメモリ（live）に持つ。操作は即座に反映して、会員へすぐ送る（WebSocket）。
// ・DB（sc_games）へは後からまとめて書く（write-behind）。書き込みが遅い・失敗しても、プレイは止まらない（再試行する）。
// ・同じゲームへの操作は1つずつ順番に処理する（同時に押されても状態が壊れないように）。
// ・終了時（SIGTERM / SIGINT）は、保存待ちのゲームを書き出してから止まる。
// ・アプリのサーバーは1台で動かす前提（メモリ上の状態を使うため）。
import { z } from "zod";
import { sendToUser } from "./hub.js";
import { insertMessage, memberIds, type MessageRow } from "./messages.js";
import { deadlineOf, GAME_CONFIG, GameError, reduce, viewOf, type GameAction, type GameKind, type GameStatus, type GameView, type Reduced, type Stored } from "./gameLogic.js";
import { generateQuizQuestions } from "./quizgen.js";
import { studioQuizFor, studioQuizFromWork } from "./studioData.js";
import { QUIZ_ROUNDS, type QuizSource } from "./gameLogic.js";
import { sb } from "./supabase.js";

type GameRow = {
  message_id: string;
  conversation_id: string;
  kind: GameKind;
  status: GameStatus;
  creator_id: string;
  state: Stored;
};

const COLUMNS = "message_id, conversation_id, kind, status, creator_id, state";

// WebSocket（game-action）と HTTP の両方で使う、操作の入力の形
export const gameActionInput = z.object({
  action: z.enum(["join", "start", "cancel", "move", "buzz", "answer", "next", "hand", "guess", "tap", "react"]),
  index: z.number().int().optional(),
  choice: z.number().int().optional(),
  hand: z.enum(["rock", "scissors", "paper"]).optional(),
  value: z.number().int().optional()
});

// 進行中のゲーム（メモリ上）
type Live = {
  messageId: string;
  conversationId: string;
  kind: GameKind;
  creator: string;
  status: GameStatus;
  state: Stored;
  // 会員の一覧（キャッシュ）。一定時間ごとに DB から読み直す
  members: Set<string> | null;
  membersAt: number;
  // 保存の状態
  dirty: boolean;
  dirtySince: number;
  saving: Promise<void> | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  failures: number;
  lastUsed: number;
};

const live = new Map<string, Live>();
const MEMBER_TTL_MS = 10_000;
const SAVE_DEBOUNCE_MS = 400;
const SAVE_MAX_WAIT_MS = 3_000;
const SAVE_RETRY_MAX_MS = 30_000;
const EVICT_IDLE_MS = 10 * 60_000;

async function gameRow(messageId: string): Promise<GameRow | null> {
  const { data, error } = await sb.from("sc_games").select(COLUMNS).eq("message_id", messageId).maybeSingle();
  if (error) throw error;
  return (data as GameRow | null) ?? null;
}

function toLive(row: GameRow): Live {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    creator: row.creator_id,
    status: row.status,
    state: row.state,
    members: null,
    membersAt: 0,
    dirty: false,
    dirtySince: 0,
    saving: null,
    saveTimer: null,
    failures: 0,
    lastUsed: Date.now()
  };
}

// メモリにあればそれを使う。なければ DB から読んで載せる
async function liveGame(messageId: string): Promise<Live | null> {
  const cached = live.get(messageId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }
  const row = await gameRow(messageId);
  if (!row) return null;
  const entry = toLive(row);
  live.set(messageId, entry);
  return entry;
}

// 同じゲームへの操作を1つずつ順番に処理する
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  queues.set(key, run);
  void run.catch(() => undefined).finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  });
  return run;
}

// 会員の一覧。キャッシュが古ければ読み直す（退出した人にも、そのうち反映される）
async function membersOf(g: Live, force = false): Promise<Set<string>> {
  if (!g.members || force || Date.now() - g.membersAt > MEMBER_TTL_MS) {
    g.members = new Set(await memberIds(g.conversationId));
    g.membersAt = Date.now();
  }
  return g.members;
}

// 操作する人が会員かを確かめる（キャッシュに無ければ読み直して、もう一度確かめる）
async function requireMember(g: Live, me: string): Promise<void> {
  let members = await membersOf(g);
  if (!members.has(me)) members = await membersOf(g, true);
  if (!members.has(me)) throw new GameError("ゲームが見つかりません。");
}

// ---- 保存（write-behind）----

function scheduleSave(g: Live, delay: number) {
  if (g.saveTimer) clearTimeout(g.saveTimer);
  g.saveTimer = setTimeout(() => {
    g.saveTimer = null;
    void flushGame(g.messageId);
  }, Math.max(0, delay));
}

// 変更があったことを記録し、少し後にまとめて保存する（連続した操作は1回の書き込みにまとめる）
function markDirty(g: Live) {
  const now = Date.now();
  if (!g.dirty) {
    g.dirty = true;
    g.dirtySince = now;
  }
  g.lastUsed = now;
  if (g.saving) return; // 保存中。終わったあとに続きを保存する
  // 終わったゲームは、すぐ保存する
  const debounce = g.status === "finished" ? 0 : SAVE_DEBOUNCE_MS;
  const latest = g.dirtySince + SAVE_MAX_WAIT_MS - now;
  scheduleSave(g, Math.min(debounce, Math.max(0, latest)));
}

async function writeGame(g: Live): Promise<void> {
  const { error } = await sb
    .from("sc_games")
    .update({ state: g.state, status: g.status, updated_at: new Date().toISOString() })
    .eq("message_id", g.messageId);
  if (error) throw error;
}

// 保存する。失敗しても進行は止めず、少し後に何度でも再試行する
async function flushGame(messageId: string): Promise<void> {
  const g = live.get(messageId);
  if (!g) return;
  if (g.saving) return g.saving;
  if (!g.dirty) return;
  g.dirty = false;
  const run = (async () => {
    try {
      await writeGame(g);
      g.failures = 0;
    } catch (error) {
      g.failures += 1;
      g.dirty = true;
      if (!g.dirtySince) g.dirtySince = Date.now();
      console.error(`[games] ミニゲームの保存に失敗しました（${g.messageId}・${g.failures}回目）。再試行します:`, error);
      scheduleSave(g, Math.min(SAVE_RETRY_MAX_MS, 1000 * 2 ** Math.min(g.failures, 5)));
    }
  })();
  g.saving = run;
  await run;
  g.saving = null;
  // 保存中に変更があった場合は、続きを保存する
  if (g.dirty && !g.saveTimer && g.failures === 0) markDirty(g);
}

// 保存待ちのゲームをすべて書き出す（サーバーの終了時に使う）
export async function flushAllGames(timeoutMs = 3000): Promise<void> {
  const work = (async () => {
    for (const g of live.values()) {
      if (g.saveTimer) clearTimeout(g.saveTimer);
      g.saveTimer = null;
      if (g.saving) await g.saving;
      if (g.dirty) await flushGame(g.messageId);
    }
  })();
  await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

// 長く使われていないゲームを、メモリから外す（保存済みのものだけ。次に使うとDBから読み直す）
const evictTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, g] of live) {
    if (!g.dirty && !g.saving && now - g.lastUsed > EVICT_IDLE_MS) live.delete(id);
  }
}, 60_000);
evictTimer.unref();

// 終了時に保存してから止まる（保存待ちを失わないように）
let exiting = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (exiting) return;
    exiting = true;
    void flushAllGames(3000).finally(() => process.exit(0));
  });
}

// ---- 制限時間のタイマー（ゲームごとに1つ）----
// 締め切りの時刻に、サーバーがそのゲームを進める
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleTick(messageId: string, deadline: number | null) {
  const previous = timers.get(messageId);
  if (previous) clearTimeout(previous);
  timers.delete(messageId);
  if (deadline === null) return;
  const delay = Math.min(Math.max(deadline - Date.now(), 0) + 30, 2_000_000_000);
  timers.set(
    messageId,
    setTimeout(() => {
      timers.delete(messageId);
      void tickGame(messageId).catch((error) => console.error("ミニゲームの時間切れ処理に失敗しました", error));
    }, delay)
  );
}

// 新しい状態を反映する（メモリ → 保存を予約 → 制限時間を入れ直す）
function applyResult(g: Live, next: Reduced) {
  g.state = next.stored;
  g.status = next.status;
  markDirty(g);
  scheduleTick(g.messageId, deadlineOf(g.state.play));
}

// 会員全員へ、それぞれに見せてよい形のゲームを送る（メモリの状態から。DBは読まない）
async function broadcastLive(g: Live): Promise<void> {
  const members = await membersOf(g);
  for (const uid of members) {
    sendToUser(uid, {
      type: "game",
      conversationId: g.conversationId,
      messageId: g.messageId,
      game: viewOf(g.kind, g.creator, g.state, g.status, uid)
    });
  }
}

// 時間切れの分だけ進める（押し忘れ・出し忘れがあっても止まらないように）
async function tickGame(messageId: string): Promise<void> {
  await serialize(messageId, async () => {
    const g = await liveGame(messageId);
    if (!g || g.state.cancelled) return;
    let next: Reduced;
    try {
      next = reduce(g.kind, g.creator, g.state, "", { action: "tick" });
    } catch (error) {
      // すでに終わったゲームなど、進める必要がないときは何もしない
      if (error instanceof GameError) return;
      throw error;
    }
    applyResult(g, next);
    await broadcastLive(g);
  });
}

// サーバーを再起動したあとも、進行中のゲームの締め切りを引き継ぐ（DB に保存された状態から）
export async function resumeGameTimers(): Promise<void> {
  const { data, error } = await sb.from("sc_games").select("message_id, state").eq("status", "playing");
  if (error) throw error;
  for (const row of (data ?? []) as { message_id: string; state: Stored }[]) {
    scheduleTick(row.message_id, deadlineOf(row.state.play));
  }
}

// ゲームを作る（グループのトークに「ミニゲーム」のメッセージとして出す）
export async function createGame(conversationId: string, creator: string, kind: GameKind, quizSource: QuizSource | null = null): Promise<MessageRow> {
  const row = await insertMessage(conversationId, creator, { kind: "game" }, "ミニゲーム");
  const state: Stored = { players: [creator], cancelled: false, play: null, quizSource: kind === "quiz" ? quizSource : null };
  const { error } = await sb.from("sc_games").insert({
    message_id: row.id,
    conversation_id: conversationId,
    kind,
    status: "waiting",
    creator_id: creator,
    state
  });
  if (error) throw error;
  const g = toLive({
    message_id: row.id,
    conversation_id: conversationId,
    kind,
    status: "waiting",
    creator_id: creator,
    state
  });
  live.set(row.id, g);
  await broadcastLive(g);
  return row;
}

// 参加・開始・中止・プレイの操作を1つ処理する。できない操作は GameError（理由つき）を投げる。
// HTTP（/api/dm/messages/:id/game）と WebSocket（game-action）の両方から使う。
// rttMs は接続の往復時間（WebSocket のとき）。HTTP で送ったときは 0。画面の値は使わない
export async function gameAction(messageId: string, me: string, input: GameAction, rttMs = 0): Promise<void> {
  await serialize(messageId, async () => {
    const g = await liveGame(messageId);
    if (!g) throw new GameError("ゲームが見つかりません。");
    await requireMember(g, me);
    // クイズは開始するときに問題を作る（買った問題集、なければ senninai、それも失敗なら固定の問題）
    const startingQuiz =
      g.kind === "quiz" &&
      input.action === "start" &&
      me === g.creator &&
      !g.state.play &&
      !g.state.cancelled &&
      g.state.players.length >= GAME_CONFIG.quiz.min;
    const quizQuestions = startingQuiz ? await quizQuestionsFor(me, g.state.quizSource ?? null) : null;
    const next = reduce(g.kind, g.creator, g.state, me, { ...input, rttMs }, Math.random, quizQuestions ?? undefined, Date.now());
    applyResult(g, next);
    await broadcastLive(g);
  });
}

// 募集で選ばれた出し方から問題を作る。選ばれていない古いゲームは、従来どおり
// （買った問題集からランダム → senninai → 固定の問題）。選んだ出し方が使えないときは、理由つきで断る
async function quizQuestionsFor(creator: string, source: QuizSource | null) {
  if (!source) {
    return (await studioQuizFor(creator, QUIZ_ROUNDS).catch(() => null)) ?? (await generateQuizQuestions());
  }
  if (source.type === "pack") {
    const questions = await studioQuizFromWork(creator, source.workId, QUIZ_ROUNDS);
    if (!questions) throw new GameError("選んだ問題集は使えません（購入していないか、問題数が足りません）。");
    return questions;
  }
  const questions = await generateQuizQuestions(Math.random, source.genre);
  if (!questions) throw new GameError("問題を作れませんでした。少し待ってから、もう一度「開始」を押してください。");
  return questions;
}

// 一覧（メッセージの読み込み）に付けるゲームの中身。viewer ごとに見せる範囲が変わる。
// 進行中のゲームはメモリの最新の状態を使う（DB への保存は少し遅れることがあるため）。
export async function gameViewsFor(rows: MessageRow[], viewer: string): Promise<Map<string, GameView>> {
  const views = new Map<string, GameView>();
  const ids = rows.filter((r) => r.kind === "game").map((r) => r.id);
  if (!ids.length) return views;
  const { data, error } = await sb.from("sc_games").select(COLUMNS).in("message_id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as GameRow[]) {
    const cached = live.get(row.message_id);
    if (cached) {
      views.set(row.message_id, viewOf(cached.kind, cached.creator, cached.state, cached.status, viewer));
    } else {
      views.set(row.message_id, viewOf(row.kind, row.creator_id, row.state, row.status, viewer));
    }
  }
  return views;
}
