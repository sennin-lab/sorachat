-- v29: SenninPay（友だちへの送金・店舗のQR払い）・店舗の申請・ログイン特典・ストアのラインナップ編集・運営への返却
-- 何度実行しても安全です。v28 の後に実行してください。
--
-- ・sc_pay_transfers   … 送金の記録（支払い側の減算 → 受け取り側の加算。失敗は返金。途中で止まった送金は続きから進める）
-- ・sc_merchants       … 店舗（申請すると QR が発行される。運営は停止・再開できる）
-- ・sc_login_bonus     … ログイン特典（初回ログインで30pt。1人1回）
-- ・sc_store_overrides … ストアの商品の変更（管理者パネルから。名前・価格・スタンプの中身・販売の有無、スタンプパックの追加）
--
-- 運営への返却は、環境変数 OPERATOR_USER_ID（運営の仙人アカウントに連携したソラチャットのユーザーID）で受け取り先を決めます。

create table if not exists public.sc_pay_transfers (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.sc_users(id) on delete cascade,
  to_user uuid not null references public.sc_users(id) on delete cascade,
  amount integer not null check (amount > 0 and amount <= 10000),
  memo text not null default '' check (char_length(memo) <= 60),
  kind text not null check (kind in ('friend', 'qr')),
  status text not null default 'pending' check (status in ('pending', 'debited', 'completed', 'refunded', 'failed')),
  client_id uuid,
  debit_ledger_id text,
  credit_ledger_id text,
  refund_ledger_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_user <> to_user)
);

create index if not exists sc_pay_transfers_from_idx on public.sc_pay_transfers (from_user, created_at desc);
create index if not exists sc_pay_transfers_to_idx on public.sc_pay_transfers (to_user, created_at desc);
create index if not exists sc_pay_transfers_open_idx on public.sc_pay_transfers (status) where status in ('pending', 'debited');
create unique index if not exists sc_pay_transfers_client_idx on public.sc_pay_transfers (from_user, client_id) where client_id is not null;

create table if not exists public.sc_merchants (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  description text not null default '' check (char_length(description) <= 200),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_login_bonus (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'granted')),
  attempts integer not null default 0,
  last_error text,
  granted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_store_overrides (
  item_id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- サーバー（service role）からだけ読み書きする。クライアントからは見えないようにする
alter table public.sc_pay_transfers enable row level security;
alter table public.sc_merchants enable row level security;
alter table public.sc_login_bonus enable row level security;
alter table public.sc_store_overrides enable row level security;
