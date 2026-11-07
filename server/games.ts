// ミニゲームの保存・操作・配信。進行の中身は gameLogic.ts にある。
// 1つのゲームは「game」のメッセージ1件に紐づく（sc_games.message_id）。状態は sc_games.state に保存する。
import { sendToUser } from "./hub.js";
import { insertMessage, memberIds, membership, type MessageRow } from "./messages.js";
import { deadlineOf, GAME_CONFIG, GameError, reduce, viewOf, type GameAction, type GameKind, type GameStatus, type GameView, type Reduced, type Stored } from "./gameLogic.js";
import { generateQuizQuestions } from "./quizgen.js";
import { studioQuizFor } from "./studioData.js";
import { QUIZ_ROUNDS } from "./gameLogic.js";
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

async function gameRow(messageId: string): Promise<GameRow | null> {
  const { data, error } = await sb.from("sc_games").select(COLUMNS).eq("message_id", messageId).maybeSingle();
  if (error) throw error;
  return (data as GameRow | null) ?? null;
}

// 同じゲームへの操作を1つずつ順番に処理する（同時に押されても状態が壊れないように）
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

// 制限時間のタイマー（ゲームごとに1つ）。締め切りの時刻に、サーバーがそのゲームを進める
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

// 時間切れの分だけ進める（押し忘れ・出し忘れがあっても止まらないように）
async function tickGame(messageId: string): Promise<void> {
  await serialize(messageId, async () => {
    const row = await gameRow(messageId);
    if (!row || row.state.cancelled) return;
    let next: Reduced;
    try {
      next = reduce(row.kind, row.creator_id, row.state, "", { action: "tick" });
    } catch (error) {
      // すでに終わったゲームなど、進める必要がないときは何もしない
      if (error instanceof GameError) return;
      throw error;
    }
    const { error } = await sb
      .from("sc_games")
      .update({ state: next.stored, status: next.status, updated_at: new Date().toISOString() })
      .eq("message_id", messageId);
    if (error) throw error;
    await broadcastGame(messageId);
  });
}

// サーバーを再起動したあとも、進行中のゲームの締め切りを引き継ぐ
export async function resumeGameTimers(): Promise<void> {
  const { data, error } = await sb.from("sc_games").select("message_id, state").eq("status", "playing");
  if (error) throw error;
  for (const row of (data ?? []) as { message_id: string; state: Stored }[]) {
    scheduleTick(row.message_id, deadlineOf(row.state.play));
  }
}

// 会話の全員へ、それぞれに見せてよい形のゲームを送る（締め切りのタイマーも合わせて入れ直す）
export async function broadcastGame(messageId: string): Promise<void> {
  const row = await gameRow(messageId);
  if (!row) return;
  scheduleTick(messageId, deadlineOf(row.state.play));
  for (const uid of await memberIds(row.conversation_id)) {
    sendToUser(uid, {
      type: "game",
      conversationId: row.conversation_id,
      messageId,
      game: viewOf(row.kind, row.creator_id, row.state, row.status, uid)
    });
  }
}

// ゲームを作る（グループのトークに「ミニゲーム」のメッセージとして出す）
export async function createGame(conversationId: string, creator: string, kind: GameKind): Promise<MessageRow> {
  const row = await insertMessage(conversationId, creator, { kind: "game" }, "ミニゲーム");
  const state: Stored = { players: [creator], cancelled: false, play: null };
  const { error } = await sb.from("sc_games").insert({
    message_id: row.id,
    conversation_id: conversationId,
    kind,
    status: "waiting",
    creator_id: creator,
    state
  });
  if (error) throw error;
  await broadcastGame(row.id);
  return row;
}

// 参加・開始・中止・プレイの操作を1つ処理する。できない操作は GameError（理由つき）を投げる
export async function gameAction(messageId: string, me: string, input: GameAction): Promise<void> {
  await serialize(messageId, async () => {
    const row = await gameRow(messageId);
    if (!row || !(await membership(row.conversation_id, me))) throw new GameError("ゲームが見つかりません。");
    // クイズは開始するときに senninai が問題を作る（作れなければ固定の問題を使う）
    const startingQuiz =
      row.kind === "quiz" &&
      input.action === "start" &&
      me === row.creator_id &&
      !row.state.play &&
      !row.state.cancelled &&
      row.state.players.length >= GAME_CONFIG.quiz.min;
    // 始めた人が買った問題集があれば、そこから出題する。なければ senninai が作る（それも失敗なら固定の問題）
    const quizQuestions = startingQuiz ? (await studioQuizFor(me, QUIZ_ROUNDS).catch(() => null)) ?? (await generateQuizQuestions()) : null;
    const next = reduce(row.kind, row.creator_id, row.state, me, input, Math.random, quizQuestions ?? undefined, Date.now());
    const { error } = await sb
      .from("sc_games")
      .update({ state: next.stored, status: next.status, updated_at: new Date().toISOString() })
      .eq("message_id", messageId);
    if (error) throw error;
    await broadcastGame(messageId);
  });
}

// 一覧（メッセージの読み込み）に付けるゲームの中身。viewer ごとに見せる範囲が変わる
export async function gameViewsFor(rows: MessageRow[], viewer: string): Promise<Map<string, GameView>> {
  const views = new Map<string, GameView>();
  const ids = rows.filter((r) => r.kind === "game").map((r) => r.id);
  if (!ids.length) return views;
  const { data, error } = await sb.from("sc_games").select(COLUMNS).in("message_id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as GameRow[]) {
    views.set(row.message_id, viewOf(row.kind, row.creator_id, row.state, row.status, viewer));
  }
  return views;
}
