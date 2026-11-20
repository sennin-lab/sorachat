// 開発チーム（SoraChatからのお知らせを送る公式アカウント）。ログインはできない（パスワードなし）
import { findOrCreateDm, insertMessage } from "./messages.js";
import { sb } from "./supabase.js";

export const TEAM_ID = "b0a7e000-0000-4000-8000-00000000d001";

// 友だちに開発チームを追加する（相互に1行ずつ。すでに入っていれば何もしない）
export async function befriendTeam(userId: string): Promise<void> {
  if (userId === TEAM_ID) return;
  const { error } = await sb.from("sc_friends").upsert(
    [
      { user_id: userId, friend_id: TEAM_ID },
      { user_id: TEAM_ID, friend_id: userId }
    ],
    { onConflict: "user_id,friend_id", ignoreDuplicates: true }
  );
  if (error) throw error;
}

// お知らせを、それぞれの人との1対1のトークに開発チームから送る（通知も届く）
export async function sendAnnouncement(userIds: string[], body: string): Promise<number> {
  let sent = 0;
  // 一度に送る人数を絞って、サーバーに負荷をかけすぎないようにする
  for (let i = 0; i < userIds.length; i += 10) {
    await Promise.all(
      userIds.slice(i, i + 10).map(async (uid) => {
        const conversation = await findOrCreateDm(TEAM_ID, uid);
        await insertMessage(conversation.id, TEAM_ID, { kind: "text", body }, body);
        sent += 1;
      })
    );
  }
  return sent;
}
