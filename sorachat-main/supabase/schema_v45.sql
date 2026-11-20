-- v45: 連打バトルの「練度」（累計の連打回数で、回数の上限が増える）
--   ・sc_tap_mastery: ユーザーごとの累計の連打回数（練度のレベルはこの数で決まる）
--   ・sc_tap_results: どのゲームで何回叩いたか。同じゲームを二重に数えないための記録
--   ・sc_tap_record(): 終わったゲームの回数を、1つの取引で練度に加える
-- 何度実行しても安全です。v44 の後に実行してください。

create table if not exists public.sc_tap_mastery (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  lifetime_taps bigint not null default 0 check (lifetime_taps >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.sc_tap_results (
  message_id uuid not null,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  taps integer not null check (taps >= 0),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.sc_tap_mastery enable row level security;
alter table public.sc_tap_results enable row level security;

-- p_rows: [{"user_id": "...", "taps": 123}, ...]。同じ message_id の分は1回だけ加算する。戻り値は加算した人数
create or replace function public.sc_tap_record(p_message uuid, p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  r record;
  added integer := 0;
begin
  for r in
    select (e->>'user_id')::uuid as uid, (e->>'taps')::integer as taps
    from jsonb_array_elements(p_rows) e
  loop
    insert into public.sc_tap_results (message_id, user_id, taps)
    values (p_message, r.uid, r.taps)
    on conflict (message_id, user_id) do nothing;

    if found then
      insert into public.sc_tap_mastery (user_id, lifetime_taps)
      values (r.uid, r.taps)
      on conflict (user_id) do update
        set lifetime_taps = public.sc_tap_mastery.lifetime_taps + excluded.lifetime_taps,
            updated_at = now();
      added := added + 1;
    end if;
  end loop;
  return added;
end
$$;
