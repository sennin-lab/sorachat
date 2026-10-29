-- SoraChat v7: 友だち・プロフィールの背景テーマ
-- 先に schema_v6.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- 友だち。A→B と B→A の2行を1組として保存する（相互の友だち）
create table if not exists public.sc_friends (
  user_id uuid not null references public.sc_users(id) on delete cascade,
  friend_id uuid not null references public.sc_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint sc_friends_not_self check (user_id <> friend_id)
);
create index if not exists sc_friends_friend_idx on public.sc_friends (friend_id);

alter table public.sc_friends enable row level security;
revoke all on public.sc_friends from anon, authenticated;

-- プロフィールの背景（カバー）テーマ
alter table public.sc_users add column if not exists cover_theme text not null default 'green';
alter table public.sc_users drop constraint if exists sc_users_cover_theme_check;
alter table public.sc_users add constraint sc_users_cover_theme_check
  check (cover_theme in ('green', 'sky', 'sunset', 'lavender', 'sand', 'graphite'));

-- 既存の1対1のトーク相手を友だちにする（既にあるものは重複しない）
insert into public.sc_friends (user_id, friend_id)
select distinct m1.user_id, m2.user_id
from public.sc_members m1
join public.sc_conversations c on c.id = m1.conversation_id and c.is_group = false
join public.sc_members m2 on m2.conversation_id = m1.conversation_id and m2.user_id <> m1.user_id
on conflict do nothing;
