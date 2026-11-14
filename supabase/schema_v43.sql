-- v43: 配当を投資額に応じて変える（SenninBank）。作者の受け取りは必ず売上の半分以上（最低 1pt）残す。
--   ・配当率 = 下限 + (上限 - 下限) × min(作者への投資の総額 / 満額, 1)
--   ・配当額 = 売上 × 配当率（切り捨て）。ただし作者の受け取りが売上の半分以上・最低 1pt になるよう上限を止める
--   ・既存の sc_bank_record_sale はそのまま残す（v42 の呼び出し元が残っていても壊れない）。新しい呼び出しは sc_bank_record_sale_v2 を使う
-- 何度実行しても安全です。v42 の後に実行してください。

-- 作者への投資の総額に応じた配当率
create or replace function public.sc_bank_dividend_rate(p_base numeric, p_max numeric, p_scale numeric, p_total numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_scale <= 0 or p_total <= 0 then p_base
    else p_base + (greatest(p_base, p_max) - p_base) * least(p_total / p_scale, 1)
  end;
$$;

-- 売上から配当として差し引く額（整数。切り捨て）。作者は売上の半分以上・最低 1pt を必ず受け取る
create or replace function public.sc_bank_dividend_pool(p_gross integer, p_rate numeric)
returns integer
language sql
immutable
as $$
  select greatest(0, least(
    floor(p_gross * least(greatest(p_rate, 0), 0.5))::integer,
    p_gross - greatest(1, ceil(p_gross * 0.5)::integer)
  ));
$$;

-- 売上の記録（配当率を投資額で決め、配当を差し引いて作者への支払いを作る）
-- 戻り値: {"created": bool, "withheld": int}
create or replace function public.sc_bank_record_sale_v2(
  p_payout uuid,
  p_creator uuid,
  p_work uuid,
  p_purchase uuid,
  p_charge uuid,
  p_gross integer,
  p_dividend_rate numeric,
  p_dividend_max_rate numeric,
  p_dividend_scale numeric,
  p_daily_rate numeric
)
returns jsonb
language plpgsql
as $$
declare
  pool integer;
  total numeric;
  withheld integer := 0;
  inv record;
  share integer;
begin
  -- 先に作者のロックを取り、そのあとで重複を確かめる（同じ購入の並行処理を1つずつ進めるため）
  perform pg_advisory_xact_lock(hashtext('bank-creator:' || p_creator::text));

  if exists (
    select 1 from public.sc_studio_payouts
    where (p_purchase is not null and purchase_id = p_purchase)
       or (p_charge is not null and charge_id = p_charge)
  ) then
    return jsonb_build_object('created', false, 'withheld', 0);
  end if;

  select coalesce(sum(amount), 0) into total
  from public.sc_bank_investments where creator_id = p_creator;

  pool := public.sc_bank_dividend_pool(
    p_gross,
    public.sc_bank_dividend_rate(p_dividend_rate, p_dividend_max_rate, p_dividend_scale, total)
  );

  insert into public.sc_studio_payouts
    (id, creator_id, work_id, purchase_id, charge_id, amount, gross_amount, dividend_amount, status)
  values
    (p_payout, p_creator, p_work, p_purchase, p_charge, p_gross, p_gross, 0, 'pending');

  if pool > 0 and total > 0 then
    for inv in
      select user_id, amount from public.sc_bank_investments
      where creator_id = p_creator
      order by user_id
    loop
      -- 掛け算は numeric で行う（integer のままだと大きな投資額で桁あふれする）
      share := floor(pool::numeric * inv.amount::numeric / total);
      if share > 0 then
        perform public.sc_bank_accrue(inv.user_id, p_daily_rate);
        perform public.sc_bank_credit(inv.user_id, share);
        insert into public.sc_bank_events (user_id, kind, amount, creator_id, payout_id)
        values (inv.user_id, 'dividend', share, p_creator, p_payout);
        withheld := withheld + share;
      end if;
    end loop;
  end if;

  update public.sc_studio_payouts
  set amount = p_gross - withheld, dividend_amount = withheld
  where id = p_payout;

  return jsonb_build_object('created', true, 'withheld', withheld);
end
$$;
