-- SoraChat v9: グループのアイコン画像
-- 先に schema_v8.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

alter table public.sc_conversations add column if not exists avatar_path text;

-- 会話一覧の has_avatar を、グループはグループ自身のアイコンで判定するように変更
create or replace function public.sc_list_conversations(p_user uuid)
returns table (
  conversation_id uuid,
  is_group boolean,
  name text,
  other_id uuid,
  other_username text,
  has_avatar boolean,
  last_message_at timestamptz,
  last_preview text,
  last_sender_id uuid,
  unread bigint,
  my_role text,
  member_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.is_group,
    case when c.is_group then c.title else u.display_name end,
    u.id,
    u.username,
    case when c.is_group then (c.avatar_path is not null) else (u.avatar_path is not null) end,
    c.last_message_at,
    c.last_preview,
    c.last_sender_id,
    (select count(*) from public.sc_messages msg
      where msg.conversation_id = c.id
        and msg.created_at > me.last_read_at
        and msg.sender_id <> p_user),
    me.role,
    (select count(*) from public.sc_members mm where mm.conversation_id = c.id)
  from public.sc_members me
  join public.sc_conversations c on c.id = me.conversation_id
  left join public.sc_members o on o.conversation_id = c.id and o.user_id <> p_user and not c.is_group
  left join public.sc_users u on u.id = o.user_id
  where me.user_id = p_user
  order by c.last_message_at desc;
$$;
revoke execute on function public.sc_list_conversations(uuid) from public, anon, authenticated;
grant execute on function public.sc_list_conversations(uuid) to service_role;
