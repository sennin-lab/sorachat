-- SoraChat v4: リアルタイムチャット（WebSocket）、編集、送信取り消し、転送、高速化用インデックス
-- Supabase SQL Editor で再実行しても問題ありません。

alter table public.sc_messages add column if not exists edited_at timestamptz;
alter table public.sc_messages add column if not exists deleted_at timestamptz;
alter table public.sc_messages add column if not exists forwarded boolean not null default false;

-- 送信取り消し（本文と画像を消して deleted_at を入れる）を許可するように制約を作り直す
alter table public.sc_messages drop constraint if exists sc_messages_content;
alter table public.sc_messages add constraint sc_messages_content check (
  (deleted_at is not null and body is null and image_path is null)
  or (kind = 'text' and body is not null and char_length(body) >= 1 and image_path is null)
  or (kind = 'image' and image_path is not null and body is null)
);

-- 高速化用インデックス
create index if not exists sc_messages_image_path_idx on public.sc_messages (image_path) where image_path is not null;
create index if not exists sc_members_conv_idx on public.sc_members (conversation_id);
