-- v25: グループ通話の認可を確実に効かせる（realtime.messages の RLS を有効化）
-- v22・v23 で作ったポリシーは、RLS が有効なときだけ働きます。何度実行しても安全です。
-- 必ず v22・v23・v24 の後に実行してください。

do $$
begin
  alter table realtime.messages enable row level security;
exception
  when insufficient_privilege then
    raise notice 'realtime.messages の RLS を有効にできませんでした。Supabase の SQL Editor（postgres ロール）で実行してください。';
end $$;
