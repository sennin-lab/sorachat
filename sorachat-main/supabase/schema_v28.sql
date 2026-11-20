-- v28: senninstudio のレビュー（星とコメント）と、作品の編集
-- 何度実行しても安全です。v27 の後に実行してください。
--
-- ・レビューは、その作品を買った人だけが付けられる（作者本人は不可）。1人1作品1件
-- ・作品の評価の平均・件数は、レビューから集計する（作者の評価は、作者の全作品のレビューをまとめたもの）
-- ・作品の編集で、最後に編集した日時を持つ（掲載ページに「最終更新」として出す）

create table if not exists public.sc_studio_reviews (
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  reviewer_id uuid not null references public.sc_users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (work_id, reviewer_id)
);
create index if not exists sc_studio_reviews_work_idx on public.sc_studio_reviews (work_id, updated_at desc);
create index if not exists sc_studio_reviews_reviewer_idx on public.sc_studio_reviews (reviewer_id);

alter table public.sc_studio_works add column if not exists edited_at timestamptz;

-- サーバー（service role）からだけ読み書きする
alter table public.sc_studio_reviews enable row level security;
