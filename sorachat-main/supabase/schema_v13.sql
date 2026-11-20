-- SoraChat v13: ブロック・トークごとの通知オフ・トークの削除
-- 先に schema_v12.sql まで実行してから、このファイルを Supabase SQL Editor で実行してください（再実行可）。

-- ブロック（blocker が blocked をブロックしている）
create table if not exists public.sc_blocks (
  blocker_id uuid not null references public.sc_users(id) on delete cascade,
  blocked_id uuid not null references public.sc_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists sc_blocks_blocked_idx on public.sc_blocks (blocked_id);
alter table public.sc_blocks enable row level security;

-- トークごとの通知オフ（自分の行だけ変える）
alter table public.sc_members add column if not exists muted boolean not null default false;

-- 一覧に muted を足すため、戻り値の形を変える（drop してから作り直す）
drop function if exists public.sc_list_conversations(uuid);
create function public.sc_list_conversations(p_user uuid)
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
  member_count bigint,
  muted boolean
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
    (select count(*) from public.sc_members mm where mm.conversation_id = c.id),
    me.muted
  from public.sc_members me
  join public.sc_conversations c on c.id = me.conversation_id
  left join public.sc_members o on o.conversation_id = c.id and o.user_id <> p_user and not c.is_group
  left join public.sc_users u on u.id = o.user_id
  where me.user_id = p_user
  order by c.last_message_at desc;
$$;
revoke execute on function public.sc_list_conversations(uuid) from public, anon, authenticated;
grant execute on function public.sc_list_conversations(uuid) to service_role;
