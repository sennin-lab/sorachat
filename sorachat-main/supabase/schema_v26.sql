-- v26: 仙人ストア（仙人アカウントのポイントで、外観・スタンプパック・拡張機能を買う）
-- 何度実行しても安全です。v25 の後に実行してください。
--
-- ・sc_sennin_tokens  … 仙人アカウントの更新トークン（暗号化して保存。サーバーだけが読む）
-- ・sc_store_purchases … 購入の記録（失敗・結果不明の再確認に使う）
-- ・sc_store_items     … 持っている商品
-- ・sc_users.store_theme … 選んでいる外観（持っている外観だけ選べる）

create table if not exists public.sc_sennin_tokens (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  refresh_token_enc text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_store_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.sc_users(id) on delete cascade,
  item_id text not null,
  price integer not null check (price > 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  sennin_ledger_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sc_store_purchases_user_item_idx
  on public.sc_store_purchases (user_id, item_id, status);

create table if not exists public.sc_store_items (
  user_id uuid not null references public.sc_users(id) on delete cascade,
  item_id text not null,
  purchase_id uuid references public.sc_store_purchases(id) on delete set null,
  purchased_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.sc_users add column if not exists store_theme text;

-- サーバー（service role）からだけ読み書きする。クライアントからは見えないようにする
alter table public.sc_sennin_tokens enable row level security;
alter table public.sc_store_purchases enable row level security;
alter table public.sc_store_items enable row level security;
