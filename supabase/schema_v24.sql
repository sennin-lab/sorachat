-- v24: トークに「電話に参加」カードを出すため、メッセージの種類に call を追加
-- 何度実行しても安全です。
alter table public.sc_messages drop constraint if exists sc_messages_kind_check;
alter table public.sc_messages add constraint sc_messages_kind_check
  check (kind in ('text', 'image', 'file', 'contact', 'system', 'stamp', 'poll', 'game', 'call'));
