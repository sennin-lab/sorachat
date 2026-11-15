-- Bots: SoraChat 連携の許可状態
-- 既存の sc_users(id) に合わせて作成
create table if not exists public.sc_bots_links (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  allowed boolean not null default false,
  updated_at timestamptz not null default now()
);

-- サーバー（service role）だけが読み書きする。クライアントからの直接アクセスは遮断
alter table public.sc_bots_links enable row level security;
