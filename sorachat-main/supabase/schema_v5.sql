-- SoraChat v5: 送信の重複防止（クライアントIDを保存）と、履歴取得用のインデックス
-- Supabase SQL Editor で再実行しても問題ありません。先に schema_v4.sql を実行してください。

alter table public.sc_messages add column if not exists client_id text;

do $$
begin
  alter table public.sc_messages add constraint sc_messages_client_id_length
    check (client_id is null or char_length(client_id) <= 64);
exception when duplicate_object then null;
end $$;

-- 同じ送信者が同じ clientId で二重に保存されないようにする
create unique index if not exists sc_messages_sender_client_idx
  on public.sc_messages (sender_id, client_id)
  where client_id is not null;

-- 会話ごとの新しい順（過去メッセージの読み込み用）
create index if not exists sc_messages_conv_created_idx
  on public.sc_messages (conversation_id, created_at desc);
