-- SoraChat v14: グループの出来事をトークに残す（参加・退出・削除・名前の変更）
-- 先に schema_v13.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- メッセージの種類に「system（お知らせ）」を足す
alter table public.sc_messages drop constraint if exists sc_messages_kind_check;
alter table public.sc_messages add constraint sc_messages_kind_check
  check (kind in ('text', 'image', 'file', 'contact', 'system'));
