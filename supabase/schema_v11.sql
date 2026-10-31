-- DMを開く関数を修正：1対1の会話だけを探す（グループを誤って開かないようにする）
-- 何度実行しても問題ありません。
create or replace function public.sc_open_dm(p_me uuid, p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
begin
  select m1.conversation_id into cid
  from public.sc_members m1
  join public.sc_members m2 on m2.conversation_id = m1.conversation_id
  join public.sc_conversations c on c.id = m1.conversation_id
  where m1.user_id = p_me
    and m2.user_id = p_other
    and not coalesce(c.is_group, false)
  limit 1;

  if cid is null then
    insert into public.sc_conversations (is_group) values (false) returning id into cid;
    insert into public.sc_members (conversation_id, user_id) values (cid, p_me), (cid, p_other);
  end if;

  return cid;
end;
$$;

revoke execute on function public.sc_open_dm(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sc_open_dm(uuid, uuid) to service_role;
