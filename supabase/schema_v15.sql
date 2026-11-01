-- SoraChat v15: スタンプ（組み込みと、自分でアップロードしたもの）
-- 先に schema_v14.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- メッセージの種類に「stamp（スタンプ）」を足す。スタンプの指定（builtin:… / user:ID）は stamp_ref に入れる
alter table public.sc_messages add column if not exists stamp_ref text;
alter table public.sc_messages drop constraint if exists sc_messages_kind_check;
alter table public.sc_messages add constraint sc_messages_kind_check
  check (kind in ('text', 'image', 'file', 'contact', 'system', 'stamp'));

-- 自分でアップロードしたスタンプ（画像は Storage の path に置く）
create table if not exists public.sc_user_stamps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.sc_users(id) on delete cascade,
  path text not null,
  created_at timestamptz not null default now()
);
create index if not exists sc_user_stamps_user_idx on public.sc_user_stamps (user_id, created_at desc);
alter table public.sc_user_stamps enable row level security;

-- PostgREST のスキーマキャッシュを更新する（PGRST205 対策）
notify pgrst, 'reload schema';
