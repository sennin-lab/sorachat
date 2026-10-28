alter table public.sc_conversations add column if not exists is_group boolean not null default false;
alter table public.sc_conversations add column if not exists title text;
alter table public.sc_conversations add column if not exists created_by uuid references public.sc_users(id) on delete set null;
do $$
begin
  alter table public.sc_conversations add constraint sc_conversations_title_check check (title is null or char_length(title) between 1 and 40);
exception when duplicate_object then null;
end $$;

alter table public.sc_members add column if not exists role text not null default 'member';
alter table public.sc_members add column if not exists joined_at timestamptz not null default now();
do $$
begin
  alter table public.sc_members add constraint sc_members_role_check check (role in ('owner', 'member'));
exception when duplicate_object then null;
end $$;
create unique index if not exists sc_members_one_owner on public.sc_members (conversation_id) where role = 'owner';

create table if not exists public.sc_reactions (
  message_id uuid not null references public.sc_messages(id) on delete cascade,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists public.sc_notes (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 60),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.sc_reactions enable row level security;
alter table public.sc_notes enable row level security;

create or replace function public.sc_me()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function public.sc_is_member(p_conv uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.sc_members m where m.conversation_id = p_conv and m.user_id = public.sc_me());
$$;

create or replace function public.sc_shares_with_me(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sc_members x
    join public.sc_members y on y.conversation_id = x.conversation_id
    where x.user_id = public.sc_me() and y.user_id = p_other
  );
$$;

create or replace function public.sc_topic_user()
returns uuid
language plpgsql
stable
as $$
begin
  return substr(realtime.topic(), 6)::uuid;
exception when others then
  return null;
end;
$$;

revoke execute on function public.sc_me(), public.sc_is_member(uuid), public.sc_shares_with_me(uuid), public.sc_topic_user() from public, anon;
grant execute on function public.sc_me(), public.sc_is_member(uuid), public.sc_shares_with_me(uuid), public.sc_topic_user() to authenticated;

grant select on public.sc_conversations, public.sc_members, public.sc_messages, public.sc_reactions, public.sc_notes to authenticated;

drop policy if exists sc_conversations_select on public.sc_conversations;
create policy sc_conversations_select on public.sc_conversations for select to authenticated
  using (public.sc_is_member(id));

drop policy if exists sc_members_select on public.sc_members;
create policy sc_members_select on public.sc_members for select to authenticated
  using (public.sc_is_member(conversation_id));

drop policy if exists sc_messages_select on public.sc_messages;
create policy sc_messages_select on public.sc_messages for select to authenticated
  using (public.sc_is_member(conversation_id));

drop policy if exists sc_reactions_select on public.sc_reactions;
create policy sc_reactions_select on public.sc_reactions for select to authenticated
  using (exists (
    select 1 from public.sc_messages msg
    where msg.id = sc_reactions.message_id and public.sc_is_member(msg.conversation_id)
  ));

drop policy if exists sc_notes_select on public.sc_notes;
create policy sc_notes_select on public.sc_notes for select to authenticated
  using (expires_at > now() and (user_id = public.sc_me() or public.sc_shares_with_me(user_id)));

do $$
declare t text;
begin
  foreach t in array array['sc_messages', 'sc_reactions', 'sc_members', 'sc_conversations', 'sc_notes'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

drop policy if exists sc_call_select on realtime.messages;
create policy sc_call_select on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and starts_with(realtime.topic(), 'call:')
    and (public.sc_topic_user() = public.sc_me() or public.sc_shares_with_me(public.sc_topic_user()))
  );

drop policy if exists sc_call_insert on realtime.messages;
create policy sc_call_insert on realtime.messages for insert to authenticated
  with check (
    extension = 'broadcast'
    and starts_with(realtime.topic(), 'call:')
    and (public.sc_topic_user() = public.sc_me() or public.sc_shares_with_me(public.sc_topic_user()))
  );

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
    case when c.is_group then false else (u.avatar_path is not null) end,
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

create or replace function public.sc_create_group(p_me uuid, p_title text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
begin
  insert into public.sc_conversations (is_group, title, created_by)
  values (true, p_title, p_me)
  returning id into cid;
  insert into public.sc_members (conversation_id, user_id, role) values (cid, p_me, 'owner');
  insert into public.sc_members (conversation_id, user_id)
  select cid, unnest(p_members)
  on conflict do nothing;
  return cid;
end;
$$;

revoke execute on function public.sc_list_conversations(uuid), public.sc_create_group(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.sc_list_conversations(uuid), public.sc_create_group(uuid, text, uuid[]) to service_role;
