-- SoraChat v12: senninai（AIチャット）
-- 先に schema_v11.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- ユーザーごとのAI機能のオン・オフ（既定はオフ）
alter table public.sc_users add column if not exists ai_enabled boolean not null default false;

-- ボット自身（ログインできない固定ID。is_bot で人と区別する）
alter table public.sc_users add column if not exists is_bot boolean not null default false;

-- senninai のアカウントを作る。すでに username 'senninai' の人がいる場合は、先にその人の名前を変えてから実行してください。
insert into public.sc_users (id, username, display_name, bio, password_hash, is_bot)
values ('5e11a1ab-0000-4000-8000-000000000001', 'senninai', 'senninai', 'AIチャット', null, true)
on conflict do nothing;
