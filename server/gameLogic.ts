// ミニゲームの進行ロジック（DB・通信には触れない純粋な関数）。
// 状態の更新（reduce）と、各人に見せてよい形への変換（viewOf）だけを担当する。
// 答えや相手の手など、まだ見せてはいけない情報は viewOf で取り除く。

export const GAME_KINDS = ["tictactoe", "quiz", "janken", "guess", "tap", "reflex"] as const;
export type GameKind = (typeof GAME_KINDS)[number];
export type GameStatus = "waiting" | "playing" | "finished";
export type Hand = "rock" | "scissors" | "paper";
export const HANDS: Hand[] = ["rock", "scissors", "paper"];

// 人数の上限・下限（三目並べは2人固定）
export const GAME_CONFIG: Record<GameKind, { min: number; max: number }> = {
  tictactoe: { min: 2, max: 2 },
  quiz: { min: 2, max: 8 },
  janken: { min: 2, max: 10 },
  guess: { min: 2, max: 10 },
  tap: { min: 2, max: 10 },
  reflex: { min: 2, max: 8 }
};

// 連打バトル：1秒あたりに数えてよい最大の回数（端末の連打の上限より少し多め）と、最初の余裕
export const TAP_MAX_PER_SECOND = 14;
export const TAP_GRACE = 15;
// 反射神経バトル：何ラウンドやるか
export const REFLEX_ROUNDS = 3;

export const GUESS_MAX = 100;
export const QUIZ_ROUNDS = 5;
const WIN_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];
const BEATS: Record<Hand, Hand> = { rock: "scissors", scissors: "paper", paper: "rock" };

// 修学旅行で出やすい、正解が一つに決まる問題
const QUIZ_BANK: { q: string; options: string[]; answer: number }[] = [
  { q: "京都の「金閣寺」の正式な寺の名前は？", options: ["鹿苑寺", "慈照寺", "東寺", "清水寺"], answer: 0 },
  { q: "奈良の大仏（盧遮那仏）があるお寺は？", options: ["東大寺", "興福寺", "法隆寺", "唐招提寺"], answer: 0 },
  { q: "東京タワーの高さは約何メートル？", options: ["333m", "634m", "500m", "200m"], answer: 0 },
  { q: "奈良公園で、神の使いとして大切にされている動物は？", options: ["鹿", "猿", "狐", "猫"], answer: 0 },
  { q: "日本で一番高い山は？", options: ["富士山", "北岳", "奥穂高岳", "槍ヶ岳"], answer: 0 },
  { q: "北海道の道庁所在地は？", options: ["札幌市", "函館市", "旭川市", "小樽市"], answer: 0 },
  { q: "東京ディズニーランドがある市は？", options: ["浦安市", "千葉市", "船橋市", "習志野市"], answer: 0 },
  { q: "日本の都道府県は全部でいくつ？", options: ["45", "46", "47", "48"], answer: 2 },
  { q: "大阪名物で、たこが入った粉もの料理は？", options: ["たこ焼き", "もんじゃ焼き", "ひつまぶし", "ジンギスカン"], answer: 0 },
  { q: "広島市にあり、原爆の惨禍を今に伝える世界遺産は？", options: ["原爆ドーム", "広島城", "尾道水道", "厳島神社"], answer: 0 },
  { q: "四国の県は全部でいくつ？", options: ["3", "4", "5", "6"], answer: 1 },
  { q: "日本の首都は？", options: ["東京", "大阪", "京都", "名古屋"], answer: 0 }
];

type TttPlay = {
  kind: "tictactoe";
  board: string[];
  turn: "X" | "O";
  winner: "X" | "O" | "draw" | null;
  line: number[] | null;
};
// 制限時間（ミリ秒）。時間切れはサーバーが自動で次へ進める
export const TIMING = {
  quizQuestion: 15_000, // 問題が出てから、誰かが押すまで
  quizAnswer: 10_000, // 押した人が答えるまで
  quizReveal: 6_000, // 正解を見せてから次の問題へ
  jankenHand: 15_000, // 手を出すまで（出さなかった人はランダムの手）
  jankenReveal: 6_000, // 結果を見せてから次の回へ
  tapCountdown: 3_000, // 連打バトル：「スタート」の前のカウントダウン
  tapRun: 10_000, // 連打バトル：連打する時間
  reflexWaitMin: 2_000, // 反射神経：GO までの待ち時間（最短）
  reflexWaitMax: 5_000, // 反射神経：GO までの待ち時間（最長）
  reflexGoWindow: 4_000, // GO のあと、押すまでの時間（押さない人は失敗扱い）
  reflexReveal: 3_000 // 結果を見せてから次のラウンドへ
} as const;
export type QuizQuestion = { q: string; options: string[]; answer: number };
type QuizResult = { answer: number; choice: number | null; by: string | null; correct: boolean };
type QuizPlay = {
  kind: "quiz";
  questions: QuizQuestion[];
  round: number;
  phase: "question" | "revealed" | "done";
  buzzed: string | null;
  tried: string[];
  scores: Record<string, number>;
  result: QuizResult | null;
  deadline: number | null;
};
type JankenLast = { hands: Record<string, Hand>; outcome: "draw" | "win"; winningHand: Hand | null; eliminated: string[] };
type JankenPlay = {
  kind: "janken";
  round: number;
  phase: "hand" | "revealed" | "done";
  alive: string[];
  hands: Record<string, Hand>;
  last: JankenLast | null;
  champion: string | null;
  deadline: number | null;
};
type GuessPlay = {
  kind: "guess";
  secret: number;
  guesses: { by: string; value: number; result: "higher" | "lower" | "correct" }[];
  winner: string | null;
};
type TapPlay = {
  kind: "tap";
  phase: "count" | "run" | "done";
  runStart: number | null;
  counts: Record<string, number>;
  deadline: number | null;
};
type ReflexResult = { round: number; winner: string | null; times: Record<string, number | null>; falseStart: string[] };
type ReflexPlay = {
  kind: "reflex";
  round: number;
  phase: "wait" | "go" | "revealed" | "done";
  goAt: number | null;
  reacted: Record<string, number>;
  falseStart: string[];
  scores: Record<string, number>;
  last: ReflexResult | null;
  deadline: number | null;
};
export type Play = TttPlay | QuizPlay | JankenPlay | GuessPlay | TapPlay | ReflexPlay;

// DB に保存する形（答えや秘密の数字も含むので、そのままでは画面に出さない）
export type Stored = { players: string[]; cancelled: boolean; play: Play | null };

// 画面に送る形（各人に見せてよい情報だけ）
export type GameView = {
  kind: GameKind;
  status: GameStatus;
  cancelled: boolean;
  creatorId: string;
  me: string;
  players: string[];
  min: number;
  max: number;
  tictactoe: null | {
    board: string[];
    turn: "X" | "O";
    symbols: { X: string; O: string };
    winner: "X" | "O" | "draw" | null;
    line: number[] | null;
  };
  quiz: null | {
    round: number;
    total: number;
    phase: "question" | "revealed" | "done";
    question: string | null;
    options: string[];
    buzzed: string | null;
    tried: string[];
    scores: Record<string, number>;
    result: QuizResult | null;
    // 次の締め切りまでの残り（ミリ秒）。締め切りがないときは null
    deadlineIn: number | null;
  };
  janken: null | {
    round: number;
    phase: "hand" | "revealed" | "done";
    alive: string[];
    submitted: string[];
    myHand: Hand | null;
    last: JankenLast | null;
    champion: string | null;
    deadlineIn: number | null;
  };
  guess: null | {
    min: number;
    max: number;
    guesses: { by: string; value: number; result: "higher" | "lower" | "correct" }[];
    secret: number | null;
    winner: string | null;
  };
  tap: null | {
    phase: "count" | "run" | "done";
    // 各人のこれまでの回数（画面の全員分。締め切りのあとは最終結果）
    counts: Record<string, number>;
    // 「スタート」まで・終わるまでの残り（ミリ秒）
    deadlineIn: number | null;
  };
  reflex: null | {
    round: number;
    total: number;
    phase: "wait" | "go" | "revealed" | "done";
    // 押した人（GO の前に押した人は falseStart）
    reacted: string[];
    falseStart: string[];
    // 自分の反応時間（ミリ秒）。まだ押していなければ null
    myMs: number | null;
    scores: Record<string, number>;
    last: ReflexResult | null;
    // GO の前は秘密（待ち時間を見せない）。GO のあとは押すまでの残り
    deadlineIn: number | null;
  };
};

export type GameAction = {
  // tick は制限時間のタイマーからだけ送る（画面からは送らない）
  // tap：連打バトルの回数（value）。react：反射神経バトルで押した（反応時間は下の rttMs で補正する）
  action: "join" | "start" | "cancel" | "move" | "buzz" | "answer" | "next" | "hand" | "guess" | "tap" | "react" | "tick";
  index?: number;
  choice?: number;
  hand?: Hand;
  value?: number;
  // サーバーだけが入れる：押した人の往復時間（ミリ秒）。画面からは受け取らない
  rttMs?: number;
};

export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}

const shuffle = <T>(list: T[], random: () => number): T[] => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

// quizQuestions は senninai が作った問題（足りないときは固定の問題を使う）
function startPlay(kind: GameKind, players: string[], random: () => number, now: number, quizQuestions?: QuizQuestion[]): Play {
  if (kind === "tictactoe") return { kind, board: Array(9).fill(""), turn: "X", winner: null, line: null };
  if (kind === "tap") {
    const counts: Record<string, number> = {};
    for (const uid of players) counts[uid] = 0;
    return { kind, phase: "count", runStart: null, counts, deadline: now + TIMING.tapCountdown };
  }
  if (kind === "reflex") {
    const scores: Record<string, number> = {};
    for (const uid of players) scores[uid] = 0;
    const goAt = now + reflexWait(random);
    return { kind, round: 1, phase: "wait", goAt, reacted: {}, falseStart: [], scores, last: null, deadline: goAt };
  }
  if (kind === "quiz") {
    const scores: Record<string, number> = {};
    for (const uid of players) scores[uid] = 0;
    return {
      kind,
      questions:
        quizQuestions && quizQuestions.length >= QUIZ_ROUNDS
          ? quizQuestions.slice(0, QUIZ_ROUNDS)
          : shuffle(QUIZ_BANK, random).slice(0, QUIZ_ROUNDS),
      round: 0,
      phase: "question",
      buzzed: null,
      tried: [],
      scores,
      result: null,
      deadline: now + TIMING.quizQuestion
    };
  }
  if (kind === "janken") {
    return { kind, round: 1, phase: "hand", alive: [...players], hands: {}, last: null, champion: null, deadline: now + TIMING.jankenHand };
  }
  return { kind, secret: 1 + Math.floor(random() * GUESS_MAX), guesses: [], winner: null };
}

export function isFinished(play: Play | null): boolean {
  if (!play) return false;
  if (play.kind === "tictactoe") return play.winner !== null;
  if (play.kind === "guess") return play.winner !== null;
  return play.phase === "done";
}

// 次の締め切り（ミリ秒の時刻）。締め切りのないゲームは null
export function deadlineOf(play: Play | null): number | null {
  if (!play || play.kind === "tictactoe" || play.kind === "guess") return null;
  return typeof play.deadline === "number" ? play.deadline : null;
}

function remainingOf(play: { phase: string; deadline: number | null }, now: number): number | null {
  if (play.phase === "done" || typeof play.deadline !== "number") return null;
  return Math.max(0, play.deadline - now);
}

// 反射神経：GO までの待ち時間（ミリ秒）
function reflexWait(random: () => number): number {
  return Math.round(TIMING.reflexWaitMin + random() * (TIMING.reflexWaitMax - TIMING.reflexWaitMin));
}

// 反射神経の1ラウンドを締める（押した人の中で一番早い人が1点。GO の前に押した人と、押さなかった人は点なし）
function resolveReflex(play: ReflexPlay, players: string[], now: number) {
  const times: Record<string, number | null> = {};
  let winner: string | null = null;
  let best = Infinity;
  for (const uid of players) {
    const ms = play.falseStart.includes(uid) ? null : (play.reacted[uid] ?? null);
    times[uid] = ms;
    if (ms !== null && ms < best) {
      best = ms;
      winner = uid;
    }
  }
  if (winner) play.scores[winner] = (play.scores[winner] ?? 0) + 1;
  play.last = { round: play.round, winner, times, falseStart: [...play.falseStart] };
  play.phase = "revealed";
  play.deadline = now + TIMING.reflexReveal;
}

function nextReflexRound(play: ReflexPlay, random: () => number, now: number) {
  if (play.round >= REFLEX_ROUNDS) {
    play.phase = "done";
    play.deadline = null;
    return;
  }
  play.round += 1;
  play.phase = "wait";
  play.goAt = now + reflexWait(random);
  play.deadline = play.goAt;
  play.reacted = {};
  play.falseStart = [];
}

// 制限時間を過ぎていたら、サーバーが次へ進める（押し忘れ・出し忘れで止まらないように）
function applyDeadline(play: Play, players: string[], now: number, random: () => number) {
  if (play.kind === "tap") {
    if (play.phase === "done" || typeof play.deadline !== "number" || play.deadline > now) return;
    if (play.phase === "count") {
      play.phase = "run";
      play.runStart = play.deadline;
      play.deadline = play.deadline + TIMING.tapRun;
      return;
    }
    play.phase = "done";
    play.deadline = null;
    return;
  }
  if (play.kind === "reflex") {
    if (play.phase === "done" || typeof play.deadline !== "number" || play.deadline > now) return;
    if (play.phase === "wait") {
      // GO の合図。ここから押すまでの時間を数える
      play.phase = "go";
      play.deadline = (play.goAt ?? now) + TIMING.reflexGoWindow;
      return;
    }
    if (play.phase === "go") {
      resolveReflex(play, players, now);
      return;
    }
    nextReflexRound(play, random, now);
    return;
  }
  if (play.kind === "quiz") {
    if (play.phase === "done" || typeof play.deadline !== "number" || play.deadline > now) return;
    if (play.phase === "revealed") {
      quizAction(play, players, "", { action: "next" }, now);
      return;
    }
    const question = play.questions[play.round];
    if (play.buzzed) {
      // 答えるのが遅れた人は不正解扱い
      const late = play.buzzed;
      play.buzzed = null;
      play.tried.push(late);
      if (play.tried.length >= players.length) {
        play.phase = "revealed";
        play.result = { answer: question.answer, choice: null, by: late, correct: false };
        play.deadline = now + TIMING.quizReveal;
      } else {
        play.deadline = now + TIMING.quizQuestion;
      }
      return;
    }
    // 誰も押さなかったら、正解を見せて次へ
    play.phase = "revealed";
    play.result = { answer: question.answer, choice: null, by: null, correct: false };
    play.deadline = now + TIMING.quizReveal;
    return;
  }
  if (play.kind === "janken") {
    if (play.phase === "done" || typeof play.deadline !== "number" || play.deadline > now) return;
    if (play.phase === "hand") {
      // 出さなかった人は、ランダムの手を出したことにする
      for (const uid of play.alive) {
        if (!play.hands[uid]) play.hands[uid] = HANDS[Math.floor(random() * HANDS.length)];
      }
      resolveJanken(play, now);
      return;
    }
    jankenAction(play, "", { action: "next" }, now);
  }
}

const isIndex = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < max;

function tttMove(play: TttPlay, players: string[], me: string, index: unknown) {
  const symbol = me === players[0] ? "X" : "O";
  if (play.turn !== symbol) throw new GameError("相手の番です。");
  if (!isIndex(index, 9)) throw new GameError("マスが正しくありません。");
  if (play.board[index]) throw new GameError("そのマスはもう埋まっています。");
  play.board[index] = symbol;
  const line = WIN_LINES.find(([a, b, c]) => play.board[a] !== "" && play.board[a] === play.board[b] && play.board[a] === play.board[c]);
  if (line) {
    play.winner = symbol;
    play.line = line;
  } else if (play.board.every((cell) => cell !== "")) {
    play.winner = "draw";
  } else {
    play.turn = symbol === "X" ? "O" : "X";
  }
}

function quizAction(play: QuizPlay, players: string[], me: string, input: GameAction, now: number) {
  const question = play.questions[play.round];
  switch (input.action) {
    case "buzz": {
      if (play.phase !== "question") throw new GameError("今は押せません。");
      if (play.buzzed) throw new GameError("ほかの人が先に押しました。");
      if (play.tried.includes(me)) throw new GameError("この問題はもう答えています。");
      play.buzzed = me;
      play.deadline = now + TIMING.quizAnswer;
      return;
    }
    case "answer": {
      if (play.phase !== "question" || play.buzzed !== me) throw new GameError("先に押した人が答えます。");
      if (!isIndex(input.choice, question.options.length)) throw new GameError("選択肢が正しくありません。");
      const choice = input.choice;
      play.buzzed = null;
      if (choice === question.answer) {
        play.scores[me] = (play.scores[me] ?? 0) + 1;
        play.phase = "revealed";
        play.result = { answer: question.answer, choice, by: me, correct: true };
        play.deadline = now + TIMING.quizReveal;
        return;
      }
      play.tried.push(me);
      // 全員が答えて外れたら、正解を見せて次へ
      if (play.tried.length >= players.length) {
        play.phase = "revealed";
        play.result = { answer: question.answer, choice, by: me, correct: false };
        play.deadline = now + TIMING.quizReveal;
      } else {
        play.deadline = now + TIMING.quizQuestion;
      }
      return;
    }
    case "next": {
      if (play.phase !== "revealed") throw new GameError("まだ次の問題へ進めません。");
      play.round += 1;
      play.tried = [];
      play.buzzed = null;
      play.result = null;
      play.phase = play.round >= play.questions.length ? "done" : "question";
      play.deadline = play.phase === "done" ? null : now + TIMING.quizQuestion;
      return;
    }
    default:
      throw new GameError("この操作はできません。");
  }
}

function resolveJanken(play: JankenPlay, now: number) {
  const hands = { ...play.hands };
  const used = [...new Set(play.alive.map((uid) => hands[uid]))];
  if (used.length !== 2) {
    // グー・チョキ・パーが全部そろった、または全員同じ手なら、あいこ
    play.last = { hands, outcome: "draw", winningHand: null, eliminated: [] };
  } else {
    const [a, b] = used;
    const winningHand = BEATS[a] === b ? a : b;
    const eliminated = play.alive.filter((uid) => hands[uid] !== winningHand);
    play.alive = play.alive.filter((uid) => !eliminated.includes(uid));
    play.last = { hands, outcome: "win", winningHand, eliminated };
    if (play.alive.length === 1) play.champion = play.alive[0];
  }
  play.hands = {};
  play.phase = "revealed";
  play.deadline = now + TIMING.jankenReveal;
}

function jankenAction(play: JankenPlay, me: string, input: GameAction, now: number) {
  switch (input.action) {
    case "hand": {
      if (play.phase !== "hand") throw new GameError("今は出せません。");
      if (!play.alive.includes(me)) throw new GameError("もう負けています。");
      if (!input.hand || !HANDS.includes(input.hand)) throw new GameError("手が正しくありません。");
      if (play.hands[me]) throw new GameError("もう出しています。");
      play.hands[me] = input.hand;
      if (play.alive.every((uid) => play.hands[uid])) resolveJanken(play, now);
      return;
    }
    case "next": {
      if (play.phase !== "revealed") throw new GameError("まだ次の回へ進めません。");
      if (play.champion) {
        play.phase = "done";
        play.deadline = null;
        return;
      }
      play.round += 1;
      play.phase = "hand";
      play.hands = {};
      play.deadline = now + TIMING.jankenHand;
      return;
    }
    default:
      throw new GameError("この操作はできません。");
  }
}

function tapAction(play: TapPlay, me: string, input: GameAction, now: number) {
  if (input.action !== "tap") throw new GameError("この操作はできません。");
  if (play.phase !== "run") throw new GameError("まだ始まっていないか、終わっています。");
  const n = input.value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 30) throw new GameError("回数が正しくありません。");
  // 送られた回数は、経過した時間で上限を決めて抑える（不正な連打の防止）
  const elapsed = Math.max(0, now - (play.runStart ?? now));
  const cap = Math.floor((TAP_MAX_PER_SECOND * elapsed) / 1000) + TAP_GRACE;
  play.counts[me] = Math.min(cap, (play.counts[me] ?? 0) + n);
}

function reflexAction(play: ReflexPlay, players: string[], me: string, input: GameAction, now: number) {
  if (input.action !== "react") throw new GameError("この操作はできません。");
  if (play.phase === "wait") {
    // GO の前に押した：フライング（このラウンドは点なし）
    if (!play.falseStart.includes(me)) play.falseStart.push(me);
    return;
  }
  if (play.phase !== "go") throw new GameError("今は押せません。");
  if (play.falseStart.includes(me) || me in play.reacted) throw new GameError("もう押しています。");
  // 反応時間 = 届いた時刻 − GO の時刻 − 往復時間（GO の知らせが届くまでと、押した知らせが届くまでの分を引く）
  const rtt = Math.min(2_000, Math.max(0, input.rttMs ?? 0));
  const ms = now - (play.goAt ?? now) - rtt;
  if (ms < 0) {
    // 補正しても GO より前：フライング
    play.falseStart.push(me);
  } else {
    play.reacted[me] = Math.round(ms);
  }
  const everyoneDone = players.every((uid) => uid in play.reacted || play.falseStart.includes(uid));
  if (everyoneDone) resolveReflex(play, players, now);
}

function guessAction(play: GuessPlay, me: string, input: GameAction) {
  if (input.action !== "guess") throw new GameError("この操作はできません。");
  const value = input.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > GUESS_MAX) {
    throw new GameError(`1〜${GUESS_MAX}の数字を入力してください。`);
  }
  // 「higher」は秘密の数字の方が大きい、「lower」は小さい、という意味
  const result = value === play.secret ? "correct" : value < play.secret ? "higher" : "lower";
  play.guesses.push({ by: me, value, result });
  if (result === "correct") play.winner = me;
}

function playAction(play: Play, players: string[], me: string, input: GameAction, now: number, random: () => number) {
  if (play.kind === "tap") {
    tapAction(play, me, input, now);
  } else if (play.kind === "reflex") {
    reflexAction(play, players, me, input, now);
  } else if (play.kind === "tictactoe") {
    if (input.action !== "move") throw new GameError("この操作はできません。");
    tttMove(play, players, me, input.index);
  } else if (play.kind === "quiz") {
    quizAction(play, players, me, input, now);
  } else if (play.kind === "janken") {
    jankenAction(play, me, input, now);
  } else {
    guessAction(play, me, input);
  }
}

export type Reduced = { stored: Stored; status: GameStatus };

// 操作を1つ適用した新しい状態を返す（元の状態は変えない）。できない操作は GameError を投げる
export function reduce(
  kind: GameKind,
  creator: string,
  current: Stored,
  me: string,
  input: GameAction,
  random: () => number = Math.random,
  quizQuestions?: QuizQuestion[],
  now: number = Date.now()
): Reduced {
  const stored: Stored = JSON.parse(JSON.stringify(current));
  if (stored.cancelled || isFinished(stored.play)) throw new GameError("このゲームは終わっています。");
  // 制限時間を過ぎていれば、先に時間切れの分を進めてから操作を処理する
  if (stored.play) applyDeadline(stored.play, stored.players, now, random);
  if (input.action !== "tick" && isFinished(stored.play)) throw new GameError("このゲームは終わっています。");

  switch (input.action) {
    case "tick":
      // 時間切れの分は上で進めたので、ここでは何もしない
      break;
    case "join": {
      if (stored.play) throw new GameError("もう始まっています。");
      if (stored.players.includes(me)) throw new GameError("すでに参加しています。");
      if (stored.players.length >= GAME_CONFIG[kind].max) throw new GameError("参加人数がいっぱいです。");
      stored.players.push(me);
      // 三目並べは2人そろったら、その場で始まる
      if (kind === "tictactoe" && stored.players.length === GAME_CONFIG[kind].max) {
        stored.play = startPlay(kind, stored.players, random, now, quizQuestions);
      }
      break;
    }
    case "start": {
      if (me !== creator) throw new GameError("始められるのは作った人だけです。");
      if (stored.play) throw new GameError("もう始まっています。");
      if (stored.players.length < GAME_CONFIG[kind].min) {
        throw new GameError(`${GAME_CONFIG[kind].min}人そろってから始めてください。`);
      }
      stored.play = startPlay(kind, stored.players, random, now, quizQuestions);
      break;
    }
    case "cancel": {
      if (me !== creator) throw new GameError("中止できるのは作った人だけです。");
      stored.cancelled = true;
      break;
    }
    default: {
      if (!stored.play) throw new GameError("まだ始まっていません。");
      if (!stored.players.includes(me)) throw new GameError("参加者だけができます。");
      playAction(stored.play, stored.players, me, input, now, random);
    }
  }

  const finished = stored.cancelled || isFinished(stored.play);
  const status: GameStatus = finished ? "finished" : stored.play ? "playing" : "waiting";
  return { stored, status };
}

// 画面に送る形に変える。viewer は見ている人（自分の手などを出すため）
export function viewOf(kind: GameKind, creator: string, stored: Stored, status: GameStatus, viewer: string, now: number = Date.now()): GameView {
  const view: GameView = {
    kind,
    status,
    cancelled: stored.cancelled,
    creatorId: creator,
    me: viewer,
    players: [...stored.players],
    min: GAME_CONFIG[kind].min,
    max: GAME_CONFIG[kind].max,
    tictactoe: null,
    quiz: null,
    janken: null,
    guess: null,
    tap: null,
    reflex: null
  };
  const play = stored.play;
  if (!play) return view;

  if (play.kind === "tictactoe") {
    view.tictactoe = {
      board: [...play.board],
      turn: play.turn,
      symbols: { X: stored.players[0], O: stored.players[1] },
      winner: play.winner,
      line: play.line
    };
  } else if (play.kind === "quiz") {
    const current = play.questions[Math.min(play.round, play.questions.length - 1)];
    const done = play.phase === "done";
    view.quiz = {
      round: play.round,
      total: play.questions.length,
      phase: play.phase,
      question: done ? null : current.q,
      options: done ? [] : [...current.options],
      buzzed: play.buzzed,
      tried: [...play.tried],
      scores: { ...play.scores },
      result: play.result,
      deadlineIn: remainingOf(play, now)
    };
  } else if (play.kind === "janken") {
    view.janken = {
      round: play.round,
      phase: play.phase,
      alive: [...play.alive],
      submitted: Object.keys(play.hands),
      myHand: play.hands[viewer] ?? null,
      last: play.last,
      champion: play.champion,
      deadlineIn: remainingOf(play, now)
    };
  } else if (play.kind === "tap") {
    view.tap = {
      phase: play.phase,
      counts: { ...play.counts },
      deadlineIn: remainingOf(play, now)
    };
  } else if (play.kind === "reflex") {
    view.reflex = {
      round: play.round,
      total: REFLEX_ROUNDS,
      phase: play.phase,
      reacted: Object.keys(play.reacted),
      falseStart: [...play.falseStart],
      myMs: play.reacted[viewer] ?? null,
      scores: { ...play.scores },
      last: play.last,
      // GO の前は待ち時間を見せない（押すタイミングを知られないように）
      deadlineIn: play.phase === "wait" ? null : remainingOf(play, now)
    };
  } else {
    const revealed = status === "finished";
    view.guess = {
      min: 1,
      max: GUESS_MAX,
      guesses: play.guesses.map((g) => ({ ...g })),
      secret: revealed ? play.secret : null,
      winner: play.winner
    };
  }
  return view;
}
