// ミニゲームのメモリ上の進行と、DBへの非同期保存（write-behind）の確認。実際のSupabaseには接続しない（sb をスタブする）。
import "./env.ts";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { sb } = await import("../server/supabase.ts");
const { gameAction, gameViewsFor, flushAllGames } = await import("../server/games.ts");
const { GameError } = await import("../server/gameLogic.ts");

// ---- 最小限の Supabase のスタブ（select / eq / in / maybeSingle / insert / update）----
const tables: Record<string, any[]> = { sc_games: [], sc_members: [] };
const writes: { table: string; payload: any }[] = [];
let failNextUpdates = 0;

function builder(table: string) {
  let op: "select" | "insert" | "update" = "select";
  let payload: any = null;
  const filters: { col: string; val: any; isIn: boolean }[] = [];
  const match = (row: any) => filters.every((f) => (f.isIn ? f.val.includes(row[f.col]) : row[f.col] === f.val));
  const exec = async (single: boolean): Promise<any> => {
    const rows = tables[table] ?? [];
    if (op === "update") {
      if (failNextUpdates > 0) {
        failNextUpdates -= 1;
        return { data: null, error: { message: "一時的な失敗" } };
      }
      writes.push({ table, payload });
      for (const row of rows.filter(match)) Object.assign(row, payload);
      return { data: null, error: null };
    }
    if (op === "insert") {
      rows.push(payload);
      return { data: null, error: null };
    }
    const data = rows.filter(match).map((row) => structuredClone(row));
    return single ? { data: data[0] ?? null, error: null } : { data, error: null };
  };
  const api: any = {
    select: () => api,
    eq: (col: string, val: any) => {
      filters.push({ col, val, isIn: false });
      return api;
    },
    in: (col: string, val: any[]) => {
      filters.push({ col, val, isIn: true });
      return api;
    },
    maybeSingle: () => exec(true),
    insert: (p: any) => {
      op = "insert";
      payload = p;
      return api;
    },
    update: (p: any) => {
      op = "update";
      payload = p;
      return api;
    },
    then: (resolve: any, reject: any) => exec(false).then(resolve, reject)
  };
  return api;
}
(sb as any).from = (table: string) => builder(table);

const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 準備：A（作成者）と B（参加者）の三目並べ。C は会員ではない ----
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const CONV = randomUUID();
const GAME = randomUUID();
tables.sc_members.push(
  { conversation_id: CONV, user_id: A, role: "owner" },
  { conversation_id: CONV, user_id: B, role: "member" }
);
tables.sc_games.push({
  message_id: GAME,
  conversation_id: CONV,
  kind: "tictactoe",
  status: "waiting",
  creator_id: A,
  state: { players: [A], cancelled: false, play: null }
});

// 1) 参加すると、メモリ上ですぐ始まる。DB へはまだ書かない（write-behind）
await gameAction(GAME, B, { action: "join" });
assert.equal(writes.length, 0, "操作の直後は DB に書かない");
const stored = tables.sc_games[0];
assert.equal(stored.status, "waiting", "DB の状態はまだ古い");

// 2) 会員でない人の操作は断る（理由つき）
await assert.rejects(gameAction(GAME, C, { action: "move", index: 0 }), (err: unknown) => err instanceof GameError);

// 3) 作成者の手番。連続した操作は、保存が1回にまとまる
await gameAction(GAME, A, { action: "move", index: 0 });
await gameAction(GAME, B, { action: "move", index: 4 });
await gameAction(GAME, A, { action: "move", index: 1 });
assert.equal(writes.length, 0, "まとめて保存するまで待つ");

// 4) 一覧の表示はメモリの最新の状態を使う（DB が古くても）
const views = await gameViewsFor([{ id: GAME, kind: "game" } as any], A);
assert.equal(views.get(GAME)?.status, "playing");
assert.equal(views.get(GAME)?.tictactoe?.board[0], "X");

// 5) 少し待つと保存される
await waitFor(700);
assert.equal(writes.length, 1, "デバウンスの後に1回だけ保存する");
assert.equal(tables.sc_games[0].status, "playing");
assert.equal(tables.sc_games[0].state.play.board[0], "X");

// 6) 保存が一時的に失敗しても、進行は止まらず、あとで再試行して保存される
failNextUpdates = 1;
await gameAction(GAME, B, { action: "move", index: 2 });
await waitFor(3500);
const savedBoard = tables.sc_games[0].state.play.board;
assert.equal(savedBoard[2], "O", "再試行で最新の状態が保存される");
assert.equal(failNextUpdates, 0, "失敗が1回起きて、そのあと再試行した");

// 7) 終了時の一括保存（flushAllGames）は、保存待ちのものを書き出す
const before = writes.length;
await gameAction(GAME, A, { action: "move", index: 6 });
await flushAllGames(2000);
assert.ok(writes.length > before, "終了時の保存で書き出される");

console.log("game-live: ok");
process.exit(0);
