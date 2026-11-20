-- SoraChat v16: 投票（「＋」→「投票」で作る）
-- 先に schema_v15.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- メッセージの種類に「poll（投票）」を足す。質問・選択肢は body に暗号化して入れる（JSON）
alter table public.sc_messages drop constraint if exists sc_messages_kind_check;
alter table public.sc_messages add constraint sc_messages_kind_check
  check (kind in ('text', 'image', 'file', 'contact', 'system', 'stamp', 'poll'));

-- 投票の選択（1人が1つの選択肢に入れる。複数選択のときは同じ投票に複数行）
create table if not exists public.sc_poll_votes (
  message_id uuid not null references public.sc_messages(id) on delete cascade,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  option_index int not null check (option_index between 0 and 9),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, option_index)
);
alter table public.sc_poll_votes enable row level security;

-- PostgREST のスキーマキャッシュを更新する（PGRST205 対策）
notify pgrst, 'reload schema';
