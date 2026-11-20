-- v34: 拡張機能の中のポイント支払い（アプリ内の確認画面で、利用者が同意して支払う）と、認定開発者
-- 何度実行しても安全です。v33 の後に実行してください。
--
-- ・sc_extension_charges：拡張機能からの支払いの記録。request_id で同じ支払いを二重に取らない
-- ・sc_studio_payouts：作者への支払いは、購入（purchase_id）か拡張機能の支払い（charge_id）のどちらかに紐づく
-- ・sc_studio_creators.certified：認定開発者（管理者が指定）。認定開発者の作品は、支払いの上限が高い
--   （隔離の枠・通信禁止・sandbox は、認定の有無に関係なく同じです）

create table if not exists public.sc_extension_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.sc_users(id) on delete cascade,
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  request_id text not null,
  amount integer not null check (amount > 0),
  title text not null default '',
  status text not null default 'reserved' check (status in ('reserved', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, work_id, request_id)
);

alter table public.sc_extension_charges enable row level security;

-- 作者への支払いを、購入でも拡張機能の支払いでも作れるようにする
alter table public.sc_studio_payouts alter column purchase_id drop not null;
alter table public.sc_studio_payouts
  add column if not exists charge_id uuid unique references public.sc_extension_charges(id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sc_studio_payouts_source_check'
  ) then
    alter table public.sc_studio_payouts
      add constraint sc_studio_payouts_source_check check (purchase_id is not null or charge_id is not null);
  end if;
end $$;

-- 認定開発者（管理者が指定する）
alter table public.sc_studio_creators add column if not exists certified boolean not null default false;
