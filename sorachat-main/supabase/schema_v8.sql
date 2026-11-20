-- SoraChat v8: 返信機能
-- 先に schema_v7.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- 返信先のメッセージID（同じ会話のメッセージだけを指す。返信先が消えたら空になる）
alter table public.sc_messages add column if not exists reply_to_id uuid references public.sc_messages(id) on delete set null;
