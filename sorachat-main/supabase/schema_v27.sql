-- v27: senninstudio（作者が作品を公開して、ポイントで売る）
-- 何度実行しても安全です。v26 の後に実行してください。
--
-- ・審査なしで公開する。販売はポイント、手数料なし（購入額がそのまま作者に入る）
-- ・作品の種類: stamp_pack（スタンプ）/ theme（外観の配色）/ quiz（クイズ問題集）/ ai_style（senninai の応答スタイル）
-- ・作者は仙人アカウント連携済みの人だけ。作者ができるのは「作品の削除」だけ
-- ・通報が5件たまると自動で非公開。公開停止・復帰・作者の停止・支払いの再送は管理者が行う

-- 作者（管理者が停止できる）
create table if not exists public.sc_studio_creators (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  suspended boolean not null default false,
  suspended_reason text,
  created_at timestamptz not null default now()
);

-- 作品
create table if not exists public.sc_studio_works (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.sc_users(id) on delete cascade,
  kind text not null check (kind in ('stamp_pack', 'theme', 'quiz', 'ai_style')),
  name text not null check (char_length(name) between 1 and 40),
  description text not null default '' check (char_length(description) <= 300),
  price integer not null check (price between 10 and 1000),
  -- published: 販売中 / hidden: 非公開（通報の自動・管理者）/ deleted: 作者が削除 / removed: 管理者が削除
  status text not null default 'published' check (status in ('published', 'hidden', 'deleted', 'removed')),
  -- 非公開の理由: reports（通報が5件）/ admin（管理者）/ creator_suspended（作者の停止）
  hidden_reason text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sc_studio_works_creator_idx on public.sc_studio_works (creator_id, created_at desc);
create index if not exists sc_studio_works_status_idx on public.sc_studio_works (status, kind);

-- 作品の画像（サムネイル・スタンプ）。実体は Turso（sc_blobs）に保存する
create table if not exists public.sc_studio_images (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  role text not null check (role in ('thumb', 'stamp')),
  position integer not null default 0,
  path text not null,
  created_at timestamptz not null default now()
);
create index if not exists sc_studio_images_work_idx on public.sc_studio_images (work_id, role, position);

-- 通報（同じ人が同じ作品を2度通報しない）
create table if not exists public.sc_studio_reports (
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  reporter_id uuid not null references public.sc_users(id) on delete cascade,
  reason text not null default '' check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  primary key (work_id, reporter_id)
);

-- 作者への支払い（購入のたびに1件）。作者が未連携・権限不足のときは pending のまま残し、連携後に払う
create table if not exists public.sc_studio_payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.sc_users(id) on delete cascade,
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  purchase_id uuid not null unique references public.sc_store_purchases(id) on delete cascade,
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  attempts integer not null default 0,
  last_error text,
  sennin_ledger_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sc_studio_payouts_creator_idx on public.sc_studio_payouts (creator_id, status);

-- senninai の応答スタイル（買った作品のどれを使うか）
alter table public.sc_users add column if not exists store_ai_style text;

-- サーバー（service role）からだけ読み書きする
alter table public.sc_studio_creators enable row level security;
alter table public.sc_studio_works enable row level security;
alter table public.sc_studio_images enable row level security;
alter table public.sc_studio_reports enable row level security;
alter table public.sc_studio_payouts enable row level security;
