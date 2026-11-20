-- v39: 拡張機能のデータ保存（仙人アカウントにひもづけ・無料）
-- 何度実行しても安全です。v38 の後に実行してください。
--
-- ・保存先は仙人アカウントの ID（sennin_id）と、拡張機能（作品）の組み合わせごと。
--   同じ仙人アカウントなら、ソラチャットのアカウントを作り直しても同じデータを読める。
-- ・値は JSON。1つの値は 16KB まで、1つの組み合わせにつき 200 件まで（アプリ側で確かめる）。

create table if not exists public.sc_extension_data (
  sennin_id text not null,
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (sennin_id, work_id, key)
);

alter table public.sc_extension_data enable row level security;
