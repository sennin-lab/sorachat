-- SoraChat v10: オープンチャット・管理者機能（利用停止）
-- 先に schema_v9.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- 利用停止（BAN）の日時。入っているユーザーはログインできず、既存のログインも切られます
alter table public.sc_users add column if not exists banned_at timestamptz;

-- オープンチャット: 誰でも一覧から参加できるグループ
alter table public.sc_conversations add column if not exists is_open boolean not null default false;
alter table public.sc_conversations add column if not exists description text not null default '';
alter table public.sc_conversations drop constraint if exists sc_conversations_description_check;
alter table public.sc_conversations add constraint sc_conversations_description_check check (char_length(description) <= 200);
create index if not exists sc_conversations_open_idx on public.sc_conversations (last_message_at desc) where is_open;
