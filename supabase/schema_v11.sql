-- フレンド申請（承認されるまでは sc_friends に入れない）
-- 申請を送ると sc_friend_requests に1行入る。許可すると sc_friends に相互に保存され、申請は消える。
create table if not exists public.sc_friend_requests (
  from_id uuid not null references public.sc_users(id) on delete cascade,
  to_id uuid not null references public.sc_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);

create index if not exists sc_friend_requests_to_idx on public.sc_friend_requests (to_id);

alter table public.sc_friend_requests enable row level security;
