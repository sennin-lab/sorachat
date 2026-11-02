-- SoraChat v20: 管理者によるパスワードの再設定
-- 先に schema_v19.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- パスワードを新しく設定する（bcrypt でハッシュ化。ボット以外のユーザーだけ）
create or replace function public.sc_set_password(p_user_id uuid, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.sc_users
     set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf'))
   where id = p_user_id and is_bot = false;
  return found;
end;
$$;

revoke execute on function public.sc_set_password(uuid, text) from public, anon, authenticated;
grant execute on function public.sc_set_password(uuid, text) to service_role;

notify pgrst, 'reload schema';
