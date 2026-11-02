-- SoraChat v19: BANの理由 / 開発チーム（お知らせを送る公式アカウント）
-- 先に schema_v18.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- 利用停止の理由（管理者が入力。利用者の画面にも表示する）
alter table public.sc_users add column if not exists ban_reason text;

-- 開発チーム（ログインできない固定ID。senninai と同じく is_bot = true）
insert into public.sc_users (id, username, display_name, bio, password_hash, is_bot)
values ('b0a7e000-0000-4000-8000-00000000d001', 'sorachat_team', 'SoraChat開発チーム', 'SoraChatからのお知らせ', null, true)
on conflict do nothing;

-- 既存の全ユーザーの友だちに、開発チームを追加する（相互に1行ずつ）
insert into public.sc_friends (user_id, friend_id)
select u.id, 'b0a7e000-0000-4000-8000-00000000d001' from public.sc_users u
where u.is_bot = false and u.id <> 'b0a7e000-0000-4000-8000-00000000d001'
on conflict do nothing;
insert into public.sc_friends (user_id, friend_id)
select 'b0a7e000-0000-4000-8000-00000000d001', u.id from public.sc_users u
where u.is_bot = false and u.id <> 'b0a7e000-0000-4000-8000-00000000d001'
on conflict do nothing;

notify pgrst, 'reload schema';
