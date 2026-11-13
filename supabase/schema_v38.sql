-- v38: 拡張機能の「オンライン対戦」のサブスクリプション
-- 何度実行しても安全です。v37 の後に実行してください。
--
-- ・1週間 200pt（仙人アカウントのポイントから引く）。期限が切れる前に延長すると、期限に7日を足す。
-- ・auto_renew が true のときは、期限切れのあとに対戦を始めようとしたときだけ、1回分（200pt）を引いて更新する。
-- ・last_request_id で、同じ支払いを二重に延長しない（押し直し・通信の再送に強い）。
-- ・ポイントの増減そのものは仙人アカウント側（adjustPoints）が idempotency_key で二重にしない。

create table if not exists public.sc_battle_subscriptions (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  expires_at timestamptz not null,
  auto_renew boolean not null default true,
  last_request_id text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.sc_battle_subscriptions enable row level security;
