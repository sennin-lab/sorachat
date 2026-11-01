export type CoverTheme = "green" | "sky" | "sunset" | "lavender" | "sand" | "graphite";

export type Me = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  contact: string;
  profileUrl: string;
  hasAvatar: boolean;
  notifyDm: boolean;
  sennin: boolean;
  coverTheme: CoverTheme;
  // senninai（AIチャット）を使うか。既定はオフ
  aiEnabled: boolean;
};

export type Conversation = {
  id: string;
  isGroup: boolean;
  name: string;
  otherId: string | null;
  otherUsername: string | null;
  hasAvatar: boolean;
  lastMessageAt: string;
  lastPreview: string | null;
  lastFromMe: boolean;
  unread: number;
  myRole: "owner" | "member";
  memberCount: number;
  // このトークの通知をオフにしているか（自分だけ）
  muted: boolean;
};

export type Reaction = { emoji: string; count: number; mine: boolean };

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  // system はグループのお知らせ（参加・退出・削除・名前の変更）
  kind: "text" | "image" | "file" | "contact" | "system" | "stamp" | "poll" | "game";
  body: string | null;
  imageUrl: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileUrl?: string | null;
  contact?: { id: string; username: string; displayName: string; hasAvatar: boolean } | null;
  // スタンプの指定（builtin:ファイル名 または user:ID）
  stampRef?: string | null;
  // 投票（kind が poll のとき）。body は質問文
  poll?: PollView | null;
  // ミニゲーム（kind が game のとき）。中身は見る人ごとに違う
  game?: GameView | null;
  createdAt: string;
  edited: boolean;
  deleted: boolean;
  forwarded: boolean;
  // 返信先のメッセージID（返信でないときは null）
  replyToId?: string | null;
  reactions: Reaction[];
  clientId?: string | null;
  // 送信中・送信失敗（ローカルだけの一時表示。保存しない）
  status?: "sending" | "failed";
};

// 投票の中身と集計（counts は選択肢ごとの票数、mine は自分が選んだ番号）
// 匿名でないときは voterDetails に選択肢ごとの投票者が入る（匿名のときは null）
export type PollPerson = { id: string; name: string; hasAvatar: boolean };
export type PollView = {
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
  closedAt: string | null;
  creatorId: string;
  counts: number[];
  mine: number[];
  voters: number;
  voterDetails: PollPerson[][] | null;
};

export type GameKind = "tictactoe" | "quiz" | "janken" | "guess";
export type GameHand = "rock" | "scissors" | "paper";

// ミニゲームの画面用の形（サーバーの gameLogic.ts の GameView と同じ）
export type GameView = {
  kind: GameKind;
  status: "waiting" | "playing" | "finished";
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
    result: { answer: number; choice: number | null; by: string | null; correct: boolean } | null;
  };
  janken: null | {
    round: number;
    phase: "hand" | "revealed" | "done";
    alive: string[];
    submitted: string[];
    myHand: GameHand | null;
    last: { hands: Record<string, GameHand>; outcome: "draw" | "win"; winningHand: GameHand | null; eliminated: string[] } | null;
    champion: string | null;
  };
  guess: null | {
    min: number;
    max: number;
    guesses: { by: string; value: number; result: "higher" | "lower" | "correct" }[];
    secret: number | null;
    winner: string | null;
  };
};

export type Member = {
  id: string;
  username: string;
  displayName: string;
  hasAvatar: boolean;
  role: "owner" | "member";
};

export type UserProfile = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  contact: string;
  profileUrl: string;
  hasAvatar: boolean;
  coverTheme: CoverTheme;
  isFriend: boolean;
  friendship: FriendshipState;
  note: string | null;
};

// 友だち一覧の1人分（bio はステータスメッセージとして表示する）
export type Friend = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  hasAvatar: boolean;
  avatarVersion: string | null;
  coverTheme: CoverTheme;
};

// 1対1の相手とのフレンド関係（自分から見た状態）
export type FriendshipState = "friend" | "incoming" | "outgoing" | "none";
