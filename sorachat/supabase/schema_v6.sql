-- SoraChat v6: 返信機能（返信先メッセージのID）
-- Supabase SQL Editor で再実行しても問題ありません。先に schema_v5.sql まで実行してください。

alter table public.sc_messages add column if not exists reply_to uuid
  references public.sc_messages(id) on delete set null;

create index if not exists sc_messages_reply_to_idx on public.sc_messages (reply_to) where reply_to is not null;
