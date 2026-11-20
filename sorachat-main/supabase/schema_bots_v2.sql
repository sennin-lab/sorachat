-- Bots v2: 過去のチャットを保存する表
-- 本文・タイトルは server 側で暗号化して保存する（MESSAGE_ENCRYPTION_KEY を使う）
-- サーバー（service role）だけが読み書きする。クライアントからの直接アクセスは遮断

create table if not exists public.sc_bots_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.sc_users(id) on delete cascade,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sc_bots_chats_user_idx on public.sc_bots_chats (user_id, updated_at desc);

create table if not exists public.sc_bots_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.sc_bots_chats(id) on delete cascade,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  -- {content, thinking?, reads?, draft?} を JSON にして暗号化したもの
  payload text not null,
  -- 同じ時刻になっても順番がずれないよう、精度の高い時刻を使う
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists sc_bots_messages_chat_idx on public.sc_bots_messages (chat_id, created_at);

alter table public.sc_bots_chats enable row level security;
alter table public.sc_bots_messages enable row level security;
