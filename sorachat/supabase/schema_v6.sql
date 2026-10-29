-- SoraChat v6: ファイル添付・連絡先の送信
-- 先に schema_v5.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

alter table public.sc_messages add column if not exists file_path text;
alter table public.sc_messages add column if not exists file_name text;
alter table public.sc_messages add column if not exists file_size bigint;
alter table public.sc_messages add column if not exists contact_user_id uuid references public.sc_users(id) on delete set null;

alter table public.sc_messages drop constraint if exists sc_messages_kind_check;
alter table public.sc_messages add constraint sc_messages_kind_check
  check (kind in ('text', 'image', 'file', 'contact'));

alter table public.sc_messages drop constraint if exists sc_messages_content;
alter table public.sc_messages add constraint sc_messages_content check (
  (deleted_at is not null and body is null and image_path is null and file_path is null and contact_user_id is null)
  or (kind = 'text' and body is not null and char_length(body) >= 1 and image_path is null and file_path is null and contact_user_id is null)
  or (kind = 'image' and image_path is not null and body is null and file_path is null and contact_user_id is null)
  or (kind = 'file' and file_path is not null and file_name is not null and body is null and image_path is null and contact_user_id is null)
  or (kind = 'contact' and contact_user_id is not null and body is null and image_path is null and file_path is null)
);
