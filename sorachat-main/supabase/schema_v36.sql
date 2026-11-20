-- v36: 友だち招待キャンペーン・IP の記録・IP BAN
-- 何度実行しても安全です。v35 の後に実行してください。
--
-- ・sc_users.invite_code：各ユーザーの招待コード（新しい人は自動で付く。既存の人も下で埋める）
-- ・sc_users.signup_ip / last_ip：登録時と最後のログイン時の IP（同一IPからの招待を止めるため、管理者が見るため）
-- ・sc_referrals：招待の記録。招待された人は1回だけ（invitee_id が unique）。
--   報酬は招待した人・された人の両方に付く。仙人アカウントに連携していないなどで払えないときは 'pending' のまま残し、後で再試行する。
-- ・sc_ip_bans：BAN する IP。管理者パネルから追加・解除する。

-- 招待コード（8文字・英大文字と数字）。新しい行には自動で付く
alter table public.sc_users add column if not exists invite_code text;
alter table public.sc_users add column if not exists signup_ip text;
alter table public.sc_users add column if not exists last_ip text;

alter table public.sc_users
  alter column invite_code set default upper(substr(md5(random()::text || clock_timestamp()::text || gen_random_uuid()::text), 1, 8));

update public.sc_users
set invite_code = upper(substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 8))
where invite_code is null;

create unique index if not exists sc_users_invite_code_key on public.sc_users (invite_code);

create table if not exists public.sc_referrals (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references public.sc_users(id) on delete cascade,
  invitee_id uuid not null unique references public.sc_users(id) on delete cascade,
  inviter_ip text,
  invitee_ip text,
  inviter_status text not null default 'pending' check (inviter_status in ('pending', 'granted')),
  invitee_status text not null default 'pending' check (invitee_status in ('pending', 'granted')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sc_referrals_inviter_idx on public.sc_referrals (inviter_id);
create index if not exists sc_referrals_pending_idx on public.sc_referrals (inviter_status, invitee_status);

create table if not exists public.sc_ip_bans (
  ip text primary key,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.sc_referrals enable row level security;
alter table public.sc_ip_bans enable row level security;
