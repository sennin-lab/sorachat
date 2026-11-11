-- v35: 拡張機能の配布に「1人が1分間に受け取れるポイント数」を追加（管理者が決める）
-- 何度実行しても安全です。v34 の後に実行してください。
--
-- ・sc_extension_grants.per_user_minute_max：利用者1人が、1分間に配布で受け取れるポイントの上限。0 は制限なし（従来どおり、合計の上限だけ）
-- ・sc_extension_reserve を作り直す：同じ利用者・同じ拡張機能で、直近1分の配布（確保中・完了）の合計が上限を超えるときは 'minute_exhausted' を返す。
--   失敗した配布は数えない。同じ requestId の押し直しは、これまでどおり数えない。

alter table public.sc_extension_grants
  add column if not exists per_user_minute_max integer not null default 0 check (per_user_minute_max >= 0);

-- 配布の枠を確保する。同じ request_id が既にあれば、その今の状態を返す（再送しても二重には枠を使わない）。
-- 枠が足りなければ 'exhausted'、1分あたりの上限を超えるなら 'minute_exhausted'、配布の許可がなければ 'inactive'。
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
  minute_used integer;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ext-award:' || p_work::text));

  select id, status, points into existing
  from public.sc_extension_awards
  where user_id = p_user and work_id = p_work and request_id = p_request;
  if found then
    return jsonb_build_object('result', 'exists', 'id', existing.id, 'status', existing.status, 'points', existing.points);
  end if;

  select max_points, used_points, active, per_user_minute_max into grant_row
  from public.sc_extension_grants
  where work_id = p_work;
  if not found or not grant_row.active then
    return jsonb_build_object('result', 'inactive');
  end if;
  if grant_row.used_points + p_points > grant_row.max_points then
    return jsonb_build_object('result', 'exhausted', 'remaining', grant_row.max_points - grant_row.used_points);
  end if;

  -- 1人が1分間に受け取れる上限（0 のときは制限しない）。確保中・完了の配布だけを数える
  if grant_row.per_user_minute_max > 0 then
    select coalesce(sum(points), 0) into minute_used
    from public.sc_extension_awards
    where user_id = p_user and work_id = p_work
      and status in ('reserved', 'done')
      and created_at > now() - interval '1 minute';
    if minute_used + p_points > grant_row.per_user_minute_max then
      return jsonb_build_object(
        'result', 'minute_exhausted',
        'limit', grant_row.per_user_minute_max,
        'remaining', greatest(grant_row.per_user_minute_max - minute_used, 0)
      );
    end if;
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
