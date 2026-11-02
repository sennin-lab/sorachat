// 既存の画像（アイコン・トークの写真）を圧縮し直して Turso に保存する。
// 移行前の Supabase Storage にだけある画像は、Turso にコピーする（以後は Supabase から読まなくなる）。
// 何度実行しても安全（圧縮済みの WebP は対象にしない）。
//
//   npm run compress:images                      … 実行
//   npm run compress:images -- --dry-run         … 書き込まず、削減量だけ表示
//   npm run compress:images -- --delete-legacy   … 移行できた Supabase Storage の元ファイルも消す（既定は残す）
//
// 画像のパスは DB の参照から集めます（sc_users.avatar_path / sc_conversations.avatar_path / sc_messages.image_path）。
// 参照されていない画像は対象にしません。
import { AVATAR_OPTIONS, CHAT_IMAGE_OPTIONS, COMPRESSIBLE_TYPES, compressStoredImage, type CompressOptions } from "../imageCompress.js";
import { IMAGE_BUCKET, sb } from "../supabase.js";
import { ensureBlobTable, tursoExecute } from "../turso.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const deleteLegacy = args.has("--delete-legacy");
const PAGE = 1000;

// dm/ はトークの写真。それ以外（avatars/・groups/）はアイコン
const optionsFor = (path: string): CompressOptions => (path.startsWith("dm/") ? CHAT_IMAGE_OPTIONS : AVATAR_OPTIONS);

async function readPaths(table: string, column: string, kind?: string): Promise<string[]> {
  const paths: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const base = sb.from(table).select(`id, ${column}`).not(column, "is", null).order("id").range(from, from + PAGE - 1);
    const { data, error } = kind ? await base.eq("kind", kind) : await base;
    if (error) throw error;
    const rows = (data ?? []) as unknown as Record<string, string | null>[];
    for (const row of rows) {
      const value = row[column];
      if (value) paths.push(value);
    }
    if (rows.length < PAGE) break;
  }
  return paths;
}

async function readTursoBlob(path: string): Promise<{ type: string; data: Buffer } | null> {
  const rows = await tursoExecute("select content_type, data from sc_blobs where path = ? limit 1", [
    { type: "text", value: path }
  ]);
  const row = rows[0];
  if (!row) return null;
  const typeValue = row[0];
  const dataValue = row[1];
  const type = typeValue.type === "text" ? typeValue.value : "application/octet-stream";
  const data = dataValue.type === "blob" ? Buffer.from(dataValue.base64, "base64") : Buffer.alloc(0);
  return { type, data };
}

// 同じ path があれば上書き、なければ追加（path が主キー）
async function writeTursoBlob(path: string, type: string, buffer: Buffer) {
  await tursoExecute(
    `insert into sc_blobs (path, content_type, size, data) values (?, ?, ?, ?)
     on conflict(path) do update set content_type = excluded.content_type, size = excluded.size, data = excluded.data`,
    [
      { type: "text", value: path },
      { type: "text", value: type },
      { type: "integer", value: String(buffer.length) },
      { type: "blob", base64: buffer.toString("base64") }
    ]
  );
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

async function main() {
  await ensureBlobTable();

  const paths = new Set<string>([
    ...(await readPaths("sc_users", "avatar_path")),
    ...(await readPaths("sc_conversations", "avatar_path")),
    ...(await readPaths("sc_messages", "image_path", "image"))
  ]);
  console.log(`対象の画像: ${paths.size} 件${dryRun ? "（dry-run：書き込みません）" : ""}`);

  let converted = 0;
  let copiedFromLegacy = 0;
  let unchanged = 0;
  let missing = 0;
  let failed = 0;
  let before = 0;
  let after = 0;

  for (const path of paths) {
    try {
      const options = optionsFor(path);
      const existing = await readTursoBlob(path);
      let type: string;
      let data: Buffer;
      let fromLegacy = false;

      if (existing) {
        type = existing.type;
        data = existing.data;
      } else {
        const { data: blob, error } = await sb.storage.from(IMAGE_BUCKET).download(path);
        if (error || !blob) {
          missing += 1;
          console.warn(`見つかりません: ${path}`);
          continue;
        }
        type = blob.type || "application/octet-stream";
        data = Buffer.from(await blob.arrayBuffer());
        fromLegacy = true;
      }

      before += data.length;

      // 圧縮済みの WebP（目標サイズ以内）は、もう一度圧縮しない（画質の劣化を防ぐ）
      const alreadySmall = type === "image/webp" && data.length <= options.targetBytes;
      const compressed =
        COMPRESSIBLE_TYPES.has(type) && !alreadySmall ? await compressStoredImage(data, options) : null;

      if (!compressed && !fromLegacy) {
        unchanged += 1;
        after += data.length;
        continue;
      }

      const outBuffer = compressed ?? data;
      const outType = compressed ? "image/webp" : type;
      after += outBuffer.length;

      if (!dryRun) {
        await writeTursoBlob(path, outType, outBuffer);
        if (fromLegacy && deleteLegacy) await sb.storage.from(IMAGE_BUCKET).remove([path]);
      }

      if (compressed) converted += 1;
      if (fromLegacy) copiedFromLegacy += 1;
      console.log(
        `${compressed ? "圧縮" : "コピー"}: ${path}  ${(data.length / 1024).toFixed(0)}KB → ${(outBuffer.length / 1024).toFixed(0)}KB`
      );
    } catch (error) {
      failed += 1;
      console.error(`失敗: ${path}`, error);
    }
  }

  console.log("");
  console.log(`圧縮した画像: ${converted} 件`);
  console.log(`Supabase から Turso にコピーした画像: ${copiedFromLegacy} 件`);
  console.log(`変更なし: ${unchanged} 件 / 見つからない: ${missing} 件 / 失敗: ${failed} 件`);
  console.log(`合計サイズ: ${mb(before)}MB → ${mb(after)}MB（${before ? Math.round((1 - after / before) * 100) : 0}% 削減）`);
  if (dryRun) console.log("dry-run のため、何も書き込んでいません。");
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("失敗しました:", error);
  process.exit(1);
});
