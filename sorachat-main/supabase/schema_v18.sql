-- SoraChat v18: 利用停止（BAN）の期限つき・永久の切り替え
-- 先に schema_v17.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。
-- banned_at が入っていて banned_until が空なら「永久」、banned_until があればその日時まで。
-- 期限を過ぎた利用停止は自動で無効になります（banned_at は履歴として残ります）。
alter table public.sc_users add column if not exists banned_until timestamptz;

notify pgrst, 'reload schema';
