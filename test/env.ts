// テスト用のダミー設定（実際のSupabaseには接続しない）。import の先頭で読み込む。
import { randomBytes } from "node:crypto";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test";
process.env.SUPABASE_ANON_KEY ??= "test";
process.env.SUPABASE_JWT_SECRET ??= "test";
process.env.MESSAGE_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
