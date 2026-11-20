-- SoraChat v17: ミニゲーム（グループのトークで「＋」→「ミニゲーム」）
-- 先に schema_v16.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- メッセージの種類に「game（ミニゲーム）」を足す。中身は sc_games に入る
alter table public.sc_messages drop constraint if exists sc_messages_kind_check;
alter table public.sc_messages add constraint sc_messages_kind_check
  check (kind in ('text', 'image', 'file', 'contact', 'system', 'stamp', 'poll', 'game'));

-- ミニゲームの状態（参加者・進行・結果）。答えや秘密の数字を含むので、画面にはサーバーが必要な分だけ返す
create table if not exists public.sc_games (
  message_id uuid primary key references public.sc_messages(id) on delete cascade,
  conversation_id uuid not null references public.sc_conversations(id) on delete cascade,
  kind text not null check (kind in ('tictactoe', 'quiz', 'janken', 'guess')),
  status text not null check (status in ('waiting', 'playing', 'finished')),
  creator_id uuid not null references public.sc_users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists sc_games_conversation_idx on public.sc_games (conversation_id);
alter table public.sc_games enable row level security;

-- PostgREST のスキーマキャッシュを更新する（PGRST205 対策）
notify pgrst, 'reload schema';
