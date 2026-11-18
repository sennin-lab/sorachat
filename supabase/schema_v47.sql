-- v47: 宝くじ（sc_lotteries・sc_lottery_purchases・sc_lottery_winners）
--   ・宝くじは管理者が作る（名前・桁数・何等まで・各等のpt・結果発表日）。1券は 1000pt。
--   ・購入は purchase（1回の購入）ごとに、券の番号を持つ（numbers）。同じ操作IDで再送しても二重に買えない。
--   ・当選者は発表の時点で sc_lottery_winners に入れ、各等の賞金は仙人アカウントへ idempotency_key 付きで加算する。
-- 何度実行しても安全です。v46 の後に実行してください。

create table if not exists public.sc_lotteries (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  -- 当選番号の桁数（3〜8桁）
  digits int not null check (digits between 3 and 8),
  -- 各等の賞金（pt）。先頭が 1等（最高金額）。等の数は 1〜桁数
  tier_prizes int[] not null check (cardinality(tier_prizes) between 1 and digits),
  -- 結果発表日（日本時間の日付）。この日になると、管理者は発表できる
  announce_on date not null,
  -- 管理者が発表ボタンを押した時刻。null の間は販売中
  announced_at timestamptz,
  -- 当選番号（発表まで利用者には見せない。画面には桁ごとに公開する）
  winning_number text check (winning_number is null or char_length(winning_number) = digits),
  created_at timestamptz not null default now()
);
create index if not exists sc_lotteries_created_idx on public.sc_lotteries (created_at desc);
alter table public.sc_lotteries enable row level security;

create table if not exists public.sc_lottery_purchases (
  id uuid primary key,
  lottery_id uuid not null references public.sc_lotteries(id) on delete cascade,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  quantity int not null check (quantity between 1 and 10),
  -- 支払った pt（1券 1000pt × 枚数）
  amount int not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  -- 券の番号（枚数ぶん。桁数は宝くじの桁数と同じ）
  numbers jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists sc_lottery_purchases_lottery_idx on public.sc_lottery_purchases (lottery_id, status);
create index if not exists sc_lottery_purchases_user_idx on public.sc_lottery_purchases (user_id, lottery_id);
alter table public.sc_lottery_purchases enable row level security;

create table if not exists public.sc_lottery_winners (
  id bigint generated always as identity primary key,
  lottery_id uuid not null references public.sc_lotteries(id) on delete cascade,
  purchase_id uuid not null references public.sc_lottery_purchases(id) on delete cascade,
  idx int not null,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  tier int not null,
  number text not null,
  prize int not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lottery_id, purchase_id, idx)
);
create index if not exists sc_lottery_winners_lottery_idx on public.sc_lottery_winners (lottery_id, status);
alter table public.sc_lottery_winners enable row level security;
