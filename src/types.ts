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
};

export type Reaction = { emoji: string; count: number; mine: boolean };

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  kind: "text" | "image" | "file" | "contact";
  body: string | null;
  imageUrl: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileUrl?: string | null;
  contact?: { id: string; username: string; displayName: string; hasAvatar: boolean } | null;
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
  note: string | null;
};

// 友だち一覧の1人分（bio はステータスメッセージとして表示する）
export type Friend = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  hasAvatar: boolean;
  coverTheme: CoverTheme;
};
