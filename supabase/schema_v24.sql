-- v24: トークに「電話に参加」カードを出すため、メッセージの種類に call を追加
-- 何度実行しても安全です。
alter table public.sc_messages drop constraint if exists sc_messages_kind_check;
alter table public.sc_messages add constraint sc_messages_kind_check
  check (kind in ('text', 'image', 'file', 'contact', 'system', 'stamp', 'poll', 'game', 'call'));

-- v6 で作った内容チェック（text/image/file/contact だけを想定）は、その後に追加した種類（system・poll・game・call など）と合わないため外す。
-- 種類ごとの制約は sc_messages_kind_check（上の行）で管理する。
alter table public.sc_messages drop constraint if exists sc_messages_content;
