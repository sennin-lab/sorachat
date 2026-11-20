-- v44: 投資家ごとの取り分を、投資額に応じて変える（SenninBank）。
--   ・取り分の重み = 投資額 ^ p_dividend_exponent（1 なら投資額の割合どおり。1 より大きいと多く入れた人の割合が増える）
--   ・取り分 = 配当 × 重み ÷ 重みの合計（切り捨て）。端数は作者に残る
--   ・作者の受け取りは売上の半分以上・最低 1pt（v43 の sc_bank_dividend_pool のまま）
-- 何度実行しても安全です。v43 の後に実行してください。

create or replace function public.sc_bank_record_sale_v3(
  p_payout uuid,
  p_creator uuid,
  p_work uuid,
  p_purchase uuid,
  p_charge uuid,
  p_gross integer,
  p_dividend_rate numeric,
  p_dividend_max_rate numeric,
  p_dividend_scale numeric,
  p_dividend_exponent numeric,
  p_daily_rate numeric
)
returns jsonb
language plpgsql
as $$
declare
  pool integer;
  total numeric;
  weight_sum numeric;
  withheld integer := 0;
  inv record;
  share integer;
begin
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

  -- 投資家ごとの重み（投資額の指数乗。投資していない人は 0）の合計
  select coalesce(sum(case when amount > 0 then power(amount::numeric, p_dividend_exponent) else 0 end), 0)
  into weight_sum
  from public.sc_bank_investments where creator_id = p_creator;

  insert into public.sc_studio_payouts
    (id, creator_id, work_id, purchase_id, charge_id, amount, gross_amount, dividend_amount, status)
  values
    (p_payout, p_creator, p_work, p_purchase, p_charge, p_gross, p_gross, 0, 'pending');

  if pool > 0 and weight_sum > 0 then
    for inv in
      select user_id, amount from public.sc_bank_investments
      where creator_id = p_creator and amount > 0
      order by user_id
    loop
      share := floor(
        pool::numeric * power(inv.amount::numeric, p_dividend_exponent) / weight_sum
      );
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
