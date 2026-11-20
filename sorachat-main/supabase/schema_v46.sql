-- v46: 管理者による拡張機能のコードの書き直しの履歴
--   ・書き直した理由と、差し替えの前後のコードを残す（作者の画面には出さない）
-- 何度実行しても安全です。v45 の後に実行してください。

create table if not exists public.sc_studio_code_edits (
  id bigint generated always as identity primary key,
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  reason text not null check (char_length(reason) between 2 and 200),
  before_payload jsonb,
  after_payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists sc_studio_code_edits_work_idx on public.sc_studio_code_edits (work_id, created_at desc);
alter table public.sc_studio_code_edits enable row level security;
