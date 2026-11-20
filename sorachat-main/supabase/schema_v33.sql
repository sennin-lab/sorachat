-- v33: 拡張機能からのポイント配布（管理者が上限を決める）と、利用者の情報の許可
-- 何度実行しても安全です。v32 の後に実行してください。
--
-- ・sc_extension_grants：拡張機能ごとの配布の許可。管理者が「最大 何pt まで配れるか」を決める（active が false なら配れない）
-- ・sc_extension_consents：利用者が「ソラチャットと仙人アカウントの情報を、この拡張機能に渡してよい」と許可した記録
-- ・sc_extension_awards：配布の記録。request_id で同じ配布を二重に加算しない
-- ・配布の枠の確保（used_points を増やす）と、配布の記録の作成は、1つの関数（トランザクション）の中で行う

create table if not exists public.sc_extension_grants (
  work_id uuid primary key references public.sc_studio_works(id) on delete cascade,
  max_points integer not null default 0 check (max_points >= 0),
  used_points integer not null default 0 check (used_points >= 0),
  active boolean not null default false,
  updated_at timestamptz not null default now(),
  check (used_points <= max_points)
);

create table if not exists public.sc_extension_consents (
  user_id uuid not null references public.sc_users(id) on delete cascade,
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (user_id, work_id)
);

create table if not exists public.sc_extension_awards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.sc_users(id) on delete cascade,
  work_id uuid not null references public.sc_studio_works(id) on delete cascade,
  request_id text not null,
  points integer not null check (points > 0),
  status text not null default 'reserved' check (status in ('reserved', 'done', 'failed')),
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, work_id, request_id)
);

alter table public.sc_extension_grants enable row level security;
alter table public.sc_extension_consents enable row level security;
alter table public.sc_extension_awards enable row level security;

-- 配布の枠を確保する。同じ request_id が既にあれば、その今の状態を返す（再送しても二重には枠を使わない）。
-- 枠が足りなければ 'exhausted'、配布の許可がなければ 'inactive'。
create or replace function public.sc_extension_reserve(
  p_user uuid,
  p_work uuid,
  p_request text,
  p_points integer,
  p_reason text
) returns jsonb
language plpgsql
as $$
declare
  existing record;
  grant_row record;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ext-award:' || p_work::text));

  select id, status, points into existing
  from public.sc_extension_awards
  where user_id = p_user and work_id = p_work and request_id = p_request;
  if found then
    return jsonb_build_object('result', 'exists', 'id', existing.id, 'status', existing.status, 'points', existing.points);
  end if;

  select max_points, used_points, active into grant_row
  from public.sc_extension_grants
  where work_id = p_work;
  if not found or not grant_row.active then
    return jsonb_build_object('result', 'inactive');
  end if;
  if grant_row.used_points + p_points > grant_row.max_points then
    return jsonb_build_object('result', 'exhausted', 'remaining', grant_row.max_points - grant_row.used_points);
  end if;

  update public.sc_extension_grants
  set used_points = used_points + p_points, updated_at = now()
  where work_id = p_work;

  insert into public.sc_extension_awards (user_id, work_id, request_id, points, status, reason)
  values (p_user, p_work, p_request, p_points, 'reserved', p_reason)
  returning id into new_id;

  return jsonb_build_object('result', 'reserved', 'id', new_id, 'status', 'reserved', 'points', p_points);
end;
$$;

-- 配布の結果を記録する。failed のときは、確保した枠を戻す（1回だけ）。reserved 以外からは変えない。
create or replace function public.sc_extension_settle(p_award uuid, p_status text)
returns text
language plpgsql
as $$
declare
  row_data record;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'invalid status: %', p_status;
  end if;

  select id, work_id, points, status into row_data
  from public.sc_extension_awards
  where id = p_award
  for update;
  if not found then
    return 'missing';
  end if;
  if row_data.status <> 'reserved' then
    return row_data.status;
  end if;

  update public.sc_extension_awards
  set status = p_status, updated_at = now()
  where id = p_award;

  if p_status = 'failed' then
    update public.sc_extension_grants
    set used_points = greatest(used_points - row_data.points, 0), updated_at = now()
    where work_id = row_data.work_id;
  end if;

  return p_status;
end;
$$;
