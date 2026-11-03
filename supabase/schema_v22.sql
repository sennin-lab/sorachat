-- v22: グループ電話（Supabase Realtime の broadcast でシグナリング、音声はWebRTCで端末どうし直接）
-- 何度実行しても安全です。サーバー（Render）には負荷をかけず、通話の中身はDBにも保存しません。

-- トピックの末尾にあるUUIDを取り出す（失敗したらnull）
create or replace function public.sc_topic_uuid_after(p_prefix_len int)
returns uuid
language plpgsql
stable
as $$
begin
  return substr(realtime.topic(), p_prefix_len + 1)::uuid;
exception when others then
  return null;
end;
$$;

revoke execute on function public.sc_topic_uuid_after(int) from public, anon;
grant execute on function public.sc_topic_uuid_after(int) to authenticated;

-- call:<conversation_id> … そのグループのメンバーだけが参加できる
drop policy if exists sc_group_call_select on realtime.messages;
create policy sc_group_call_select on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and starts_with(realtime.topic(), 'call:')
    and public.sc_is_member(public.sc_topic_uuid_after(5))
  );

drop policy if exists sc_group_call_insert on realtime.messages;
create policy sc_group_call_insert on realtime.messages for insert to authenticated
  with check (
    extension = 'broadcast'
    and starts_with(realtime.topic(), 'call:')
    and public.sc_is_member(public.sc_topic_uuid_after(5))
  );

-- callin:<user_id> … 呼び出し（着信）の通知。自分の宛先だけ受け取れ、同じグループの人だけが送れる
drop policy if exists sc_call_ring_select on realtime.messages;
create policy sc_call_ring_select on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and starts_with(realtime.topic(), 'callin:')
    and public.sc_topic_uuid_after(7) = public.sc_me()
  );

drop policy if exists sc_call_ring_insert on realtime.messages;
create policy sc_call_ring_insert on realtime.messages for insert to authenticated
  with check (
    extension = 'broadcast'
    and starts_with(realtime.topic(), 'callin:')
    and public.sc_shares_with_me(public.sc_topic_uuid_after(7))
  );
