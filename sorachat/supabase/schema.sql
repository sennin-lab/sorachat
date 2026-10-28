create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sc_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  bio text not null default '' check (char_length(bio) <= 200),
  avatar_path text,
  password_hash text,
  sennin_id text unique,
  notify_dm boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.sc_sessions (
  token_hash text primary key,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sc_sessions_user_idx on public.sc_sessions (user_id);

create table if not exists public.sc_conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  last_preview text,
  last_sender_id uuid references public.sc_users(id) on delete set null
);

create table if not exists public.sc_members (
  conversation_id uuid not null references public.sc_conversations(id) on delete cascade,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists sc_members_user_idx on public.sc_members (user_id);

create table if not exists public.sc_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.sc_conversations(id) on delete cascade,
  sender_id uuid not null references public.sc_users(id) on delete cascade,
  kind text not null check (kind in ('text', 'image')),
  body text check (body is null or char_length(body) <= 1000),
  image_path text,
  created_at timestamptz not null default now(),
  constraint sc_messages_content check (
    (kind = 'text' and body is not null and char_length(body) >= 1 and image_path is null)
    or (kind = 'image' and image_path is not null and body is null)
  )
);
create index if not exists sc_messages_conv_idx on public.sc_messages (conversation_id, created_at desc);

create table if not exists public.sc_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists sc_push_user_idx on public.sc_push_subscriptions (user_id);

alter table public.sc_users enable row level security;
alter table public.sc_sessions enable row level security;
alter table public.sc_conversations enable row level security;
alter table public.sc_members enable row level security;
alter table public.sc_messages enable row level security;
alter table public.sc_push_subscriptions enable row level security;

revoke all on public.sc_users, public.sc_sessions, public.sc_conversations, public.sc_members, public.sc_messages, public.sc_push_subscriptions from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('sc-images', 'sc-images', false)
on conflict (id) do nothing;

create or replace function public.sc_register(p_username text, p_password text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_id uuid;
begin
  insert into public.sc_users (username, display_name, password_hash)
  values (lower(p_username), p_name, extensions.crypt(p_password, extensions.gen_salt('bf')))
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.sc_check_password(p_username text, p_password text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select u.id
  from public.sc_users u
  where u.username = lower(p_username)
    and u.password_hash is not null
    and u.password_hash = extensions.crypt(p_password, u.password_hash)
  limit 1;
$$;

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
  where m1.user_id = p_me and m2.user_id = p_other
  limit 1;

  if cid is null then
    insert into public.sc_conversations default values returning id into cid;
    insert into public.sc_members (conversation_id, user_id) values (cid, p_me), (cid, p_other);
  end if;

  return cid;
end;
$$;

create or replace function public.sc_list_conversations(p_user uuid)
returns table (
  conversation_id uuid,
  other_id uuid,
  other_name text,
  other_username text,
  other_has_avatar boolean,
  last_message_at timestamptz,
  last_preview text,
  last_sender_id uuid,
  unread bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    o.user_id,
    u.display_name,
    u.username,
    (u.avatar_path is not null),
    c.last_message_at,
    c.last_preview,
    c.last_sender_id,
    (select count(*) from public.sc_messages msg
      where msg.conversation_id = c.id
        and msg.created_at > me.last_read_at
        and msg.sender_id <> p_user)
  from public.sc_members me
  join public.sc_conversations c on c.id = me.conversation_id
  join public.sc_members o on o.conversation_id = c.id and o.user_id <> p_user
  join public.sc_users u on u.id = o.user_id
  where me.user_id = p_user
  order by c.last_message_at desc;
$$;

revoke execute on function public.sc_register(text, text, text) from public, anon, authenticated;
revoke execute on function public.sc_check_password(text, text) from public, anon, authenticated;
revoke execute on function public.sc_open_dm(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.sc_list_conversations(uuid) from public, anon, authenticated;
grant execute on function public.sc_register(text, text, text) to service_role;
grant execute on function public.sc_check_password(text, text) to service_role;
grant execute on function public.sc_open_dm(uuid, uuid) to service_role;
grant execute on function public.sc_list_conversations(uuid) to service_role;
