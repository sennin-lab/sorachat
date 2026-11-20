-- v31: senningames（1人で遊んで、ポイントをためるゲーム）と、ためたポイントの仙人アカウントへの出金
-- 何度実行しても安全です。v30 の後に実行してください。
--
-- ・ポイントは「ミリポイント」（1pt = 1000）の整数で持つ。0.03pt は 30 として扱い、小数の誤差を出さない
-- ・ゲームの結果（sc_solo_rounds）は、1ラウンドごとに1行。残高（sc_solo_wallets）と同じ処理の中で書き込む
-- ・出金（sc_solo_withdrawals）は 200pt ずつ。残高を減らす・出金の記録を作るを、1つの関数（トランザクション）の中で行う
-- ・仙人アカウントへの加算は idempotency_key（solo-withdraw-出金ID）で行うので、再送しても二重には入らない

create table if not exists public.sc_solo_wallets (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  milli_points bigint not null default 0 check (milli_points >= 0),
  total_milli bigint not null default 0 check (total_milli >= 0),
  withdrawn_milli bigint not null default 0 check (withdrawn_milli >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_solo_rounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.sc_users(id) on delete cascade,
  game text not null check (game in ('balloon', 'whack', 'stop', 'memory')),
  units integer not null check (units > 0),
  milli_points bigint not null check (milli_points > 0),
  created_at timestamptz not null default now()
);
create index if not exists sc_solo_rounds_user_game_idx on public.sc_solo_rounds (user_id, game, created_at desc);

create table if not exists public.sc_solo_withdrawals (
  id uuid primary key,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  points integer not null check (points > 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sc_solo_wallets enable row level security;
alter table public.sc_solo_rounds enable row level security;
alter table public.sc_solo_withdrawals enable row level security;

-- ゲーム1ラウンドの結果を加算する。前のラウンドから min_interval_ms 経っていなければ 'cooldown' を返す
create or replace function public.sc_solo_reward(
  p_user uuid,
  p_game text,
  p_units integer,
  p_milli bigint,
  p_min_interval_ms integer
) returns text
language plpgsql
as $$
declare
  last_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('solo:' || p_user::text));

  select created_at into last_at
  from public.sc_solo_rounds
  where user_id = p_user and game = p_game
  order by created_at desc
  limit 1;

  if last_at is not null and now() - last_at < (p_min_interval_ms || ' milliseconds')::interval then
    return 'cooldown';
  end if;

  insert into public.sc_solo_rounds (user_id, game, units, milli_points)
  values (p_user, p_game, p_units, p_milli);

  insert into public.sc_solo_wallets (user_id, milli_points, total_milli, withdrawn_milli)
  values (p_user, p_milli, p_milli, 0)
  on conflict (user_id) do update
    set milli_points = sc_solo_wallets.milli_points + excluded.milli_points,
        total_milli = sc_solo_wallets.total_milli + excluded.total_milli,
        updated_at = now();

  return 'ok';
end;
$$;

-- 出金を始める。同じ出金IDが既にあれば、その今の状態を返す（再送しても二重には減らない）。
-- 残高が足りなければ 'insufficient'。新しく始めたら 'started'。
create or replace function public.sc_solo_begin_withdraw(
  p_user uuid,
  p_request uuid,
  p_points integer,
  p_milli bigint
) returns text
language plpgsql
as $$
declare
  existing text;
begin
  perform pg_advisory_xact_lock(hashtext('solo:' || p_user::text));

  select status into existing
  from public.sc_solo_withdrawals
  where id = p_request and user_id = p_user;
  if found then
    return existing;
  end if;

  update public.sc_solo_wallets
  set milli_points = milli_points - p_milli,
      withdrawn_milli = withdrawn_milli + p_milli,
      updated_at = now()
  where user_id = p_user and milli_points >= p_milli;
  if not found then
    return 'insufficient';
  end if;

  insert into public.sc_solo_withdrawals (id, user_id, points, status)
  values (p_request, p_user, p_points, 'pending');

  return 'started';
end;
$$;

-- 出金の結果を記録する。refunded のときは、減らしたポイントを残高へ戻す（1回だけ）
create or replace function public.sc_solo_settle_withdraw(
  p_user uuid,
  p_request uuid,
  p_status text,
  p_milli bigint
) returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('solo:' || p_user::text));

  update public.sc_solo_withdrawals
  set status = p_status, updated_at = now()
  where id = p_request and user_id = p_user and status = 'pending';

  if found and p_status = 'refunded' then
    update public.sc_solo_wallets
    set milli_points = milli_points + p_milli,
        withdrawn_milli = withdrawn_milli - p_milli,
        updated_at = now()
    where user_id = p_user;
  end if;
end;
$$;
