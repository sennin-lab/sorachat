-- v41: 自分の画面からだけメッセージを削除する（相手の画面には残る）
-- 何度実行しても安全です。v40 の後に実行してください。
--
-- ・sc_message_hides：「この人の画面では、このメッセージを出さない」の記録。他人の投稿も自分の投稿も対象
-- ・取り消し（sc_messages の deleted_at）とは別。取り消しは全員の画面から消え、こちらは自分の画面だけ

create table if not exists public.sc_message_hides (
  user_id uuid not null references public.sc_users(id) on delete cascade,
  message_id uuid not null references public.sc_messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create index if not exists sc_message_hides_message_idx on public.sc_message_hides (message_id);

alter table public.sc_message_hides enable row level security;
