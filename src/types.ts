export type CoverTheme = "green" | "sky" | "sunset" | "lavender" | "sand" | "graphite";

export type Me = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  contact: string;
  profileUrl: string;
  hasAvatar: boolean;
  // 画像の版（変わったら値も変わる）。保存済みの画像を使うかの判断に使う
  avatarVersion?: string | null;
  notifyDm: boolean;
  sennin: boolean;
  coverTheme: CoverTheme;
  // senninai（AIチャット）を使うか。既定はオフ
  aiEnabled: boolean;
  // 仙人ストアで選んでいる外観（商品ID）。なければ null
  storeTheme?: string | null;
  // 選んでいる外観が作品なら、その配色（画面の色に反映する）
  storeThemePalette?: { mine: string; bg: string; accent: string } | null;
};

// 仙人ストアの商品（サーバーの一覧と同じ形）
export type StoreItemView = {
  id: string;
  kind: "theme" | "stamp_pack" | "extension";
  name: string;
  description: string;
  price: number;
  feature?: string;
  owned: boolean;
  selected: boolean;
  // senninstudio の作品のときだけ入る
  source?: "store" | "studio";
  creatorId?: string;
  creatorName?: string | null;
  thumbUrl?: string | null;
  studioKind?: "theme" | "stamp_pack" | "quiz" | "ai_style" | "extension" | null;
  // 作品のスタンプ（studio:画像ID の形）
  stamps?: string[];
  // 作品の評価（平均・件数）と販売数。固定の商品では null
  rating?: RatingSummary | null;
  sales?: number | null;
};

export type StoreView = {
  linked: boolean;
  selectedTheme: string | null;
  selectedAiStyle: string | null;
  items: StoreItemView[];
};

// 星の集計（平均・件数・星1〜5ごとの件数。distribution[0] が星1）
export type RatingSummary = { avg: number; count: number; distribution: number[] };

export type WorkKind = "stamp_pack" | "theme" | "quiz" | "ai_style" | "extension";

// レビュー（商品の詳細・作者のページ）
export type ReviewView = {
  reviewerId: string;
  reviewerName: string;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
};

// 商品の詳細（掲載ページ）。サーバーの /api/store/items/:id と同じ形
export type StoreDetailView = {
  id: string;
  kind: WorkKind;
  name: string;
  description: string;
  price: number;
  status: "published" | "hidden" | "deleted";
  createdAt: string;
  editedAt: string | null;
  sales: number;
  thumbUrl: string | null;
  stamps: string[];
  palette: { mine?: string; bg?: string; accent?: string } | null;
  aiStyle: { tone?: string; length?: string; emoji?: boolean } | null;
  quizCount: number | null;
  // 拡張機能のコードの大きさ（コードそのものは買うまで見せない）
  extensionBytes?: number | null;
  rating: RatingSummary;
  reviews: ReviewView[];
  myReview: ReviewView | null;
  owned: boolean;
  isMine: boolean;
  canReview: boolean;
  creator: { id: string; name: string; rating: RatingSummary; workCount: number };
};

// 作者のページ（公開）。サーバーの /api/studio/creators/:id と同じ形
export type CreatorView = {
  id: string;
  name: string;
  createdAt: string;
  rating: RatingSummary;
  workCount: number;
  sales: number;
  works: {
    id: string;
    kind: WorkKind;
    name: string;
    price: number;
    rating: RatingSummary;
    sales: number;
    thumbUrl: string | null;
  }[];
  reviews: { workId: string; workName: string; reviewerName: string; rating: number; comment: string; updatedAt: string }[];
};

// 作者の画面（senninstudio）
export type StudioWorkView = {
  id: string;
  kind: WorkKind;
  name: string;
  description: string;
  price: number;
  status: "published" | "hidden" | "deleted";
  hiddenReason: "reports" | "admin" | "creator_suspended" | null;
  // 編集フォームの初期値に使う（種類ごとの中身）
  payload: Record<string, unknown>;
  sales: number;
  rating: RatingSummary;
  thumbUrl: string | null;
  createdAt: string;
  editedAt: string | null;
};

export type StudioMeView = {
  userId: string;
  linked: boolean;
  suspended: boolean;
  suspendedReason: string | null;
  earned: number;
  pending: number;
  works: StudioWorkView[];
};

export type PayoutView = {
  id: string;
  workName: string;
  amount: number;
  status: "pending" | "paid" | "failed";
  createdAt: string;
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
  kind: "text" | "image" | "file" | "contact" | "system" | "stamp" | "poll" | "game" | "call";
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
  // 通話カード（kind が call のとき）。active は今も通話中かどうか
  call?: { callId: string; active: boolean } | null;
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
    // 次の締め切りまでの残り（ミリ秒）。締め切りがないときは null
    deadlineIn: number | null;
  };
  janken: null | {
    round: number;
    phase: "hand" | "revealed" | "done";
    alive: string[];
    submitted: string[];
    myHand: GameHand | null;
    last: { hands: Record<string, GameHand>; outcome: "draw" | "win"; winningHand: GameHand | null; eliminated: string[] } | null;
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
};

export type Member = {
  id: string;
  username: string;
  displayName: string;
  hasAvatar: boolean;
  avatarVersion?: string | null;
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

// 利用停止（BAN）の内容。until が null なら永久
export type BanInfo = { until: string | null; permanent: boolean; reason: string | null };
