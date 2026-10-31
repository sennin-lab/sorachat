// 暗号化の導入前に保存された平文のメッセージ・プレビューを、暗号化して上書きする。
// 何度実行しても安全（暗号化済みの行は対象にしない）。
//   npm run encrypt:backfill
import { encryptText, isEncrypted } from "../crypto.js";
import { sb } from "../supabase.js";

const BATCH = 500;

async function backfillMessages() {
  let total = 0;
  for (;;) {
    const { data, error } = await sb
      .from("sc_messages")
      .select("id, body")
      .not("body", "is", null)
      .not("body", "like", "v1:%")
      .limit(BATCH);
    if (error) throw error;
    const rows = (data ?? []) as { id: string; body: string }[];
    if (!rows.length) break;
    for (const row of rows) {
      if (isEncrypted(row.body)) continue;
      const { error: updateError } = await sb.from("sc_messages").update({ body: encryptText(row.body) }).eq("id", row.id);
      if (updateError) throw updateError;
    }
    total += rows.length;
    console.log(`messages: ${total} 件を暗号化しました`);
  }
  return total;
}

async function backfillPreviews() {
  let total = 0;
  for (;;) {
    const { data, error } = await sb
      .from("sc_conversations")
      .select("id, last_preview")
      .not("last_preview", "is", null)
      .not("last_preview", "like", "v1:%")
      .limit(BATCH);
    if (error) throw error;
    const rows = (data ?? []) as { id: string; last_preview: string }[];
    if (!rows.length) break;
    for (const row of rows) {
      const { error: updateError } = await sb
        .from("sc_conversations")
        .update({ last_preview: encryptText(row.last_preview) })
        .eq("id", row.id);
      if (updateError) throw updateError;
    }
    total += rows.length;
    console.log(`previews: ${total} 件を暗号化しました`);
  }
  return total;
}

backfillMessages()
  .then(backfillPreviews)
  .then(() => console.log("完了しました"))
  .catch((err) => {
    console.error("失敗しました:", err);
    process.exit(1);
  });
