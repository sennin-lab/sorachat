-- v42: SenninBank（銀行）
--   ・PT を預けると、預金に利息がつく（単利・日利。BANK_DAILY_RATE、既定 0.02%/日）
--   ・開発者（作者）に投資すると、その人の作品の売上から配当を受け取れる（BANK_DIVIDEND_RATE、既定 10%）
--     配当は作者の売上から差し引かれ、投資額の割合で投資家の預金に入る
--   ・預かり金額（預金＋利息＋投資額）のランキング。名前は本人がオフにできる（オフのときは「匿名のユーザー」）
-- 何度実行しても安全です。v41 の後に実行してください。
--
-- 設計の要点
--   ・預け入れ・引き出しだけが仙人アカウントのポイントに触る（サーバーで idempotency_key 付きで行う）。
--     この DB の関数は、その前後の「銀行の中の残高」だけを扱う。途中で止まった操作は sc_bank_ops の pending から再開する。
--   ・利息・配当・投資は銀行の中だけで動く。すべて1つの関数（1つの取引）で行う。
--   ・ロックの順番は「作者ごとのロック → ユーザーの口座」で統一し、デッドロックを防ぐ。

-- ---------------------------------------------------------------
-- テーブル
-- ---------------------------------------------------------------

-- 口座（ユーザーごとに1行）
-- principal: 預金の元本 / earned_interest: 確定済みの利息（引き出せる）/ last_accrued_at: 利息を確定した時刻
create table if not exists public.sc_bank_accounts (
  user_id uuid primary key references public.sc_users(id) on delete cascade,
  principal numeric(18, 6) not null default 0 check (principal >= 0),
  earned_interest numeric(18, 6) not null default 0 check (earned_interest >= 0),
  last_accrued_at timestamptz not null default now(),
  -- ランキングに名前を出すか（オフのときは「匿名のユーザー」）
  show_name boolean not null default true,
  created_at timestamptz not null default now()
);

-- 投資（ユーザーが作者ごとに入れている額）
create table if not exists public.sc_bank_investments (
  user_id uuid not null references public.sc_users(id) on delete cascade,
  creator_id uuid not null references public.sc_users(id) on delete cascade,
  amount integer not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, creator_id),
  check (user_id <> creator_id)
);
create index if not exists sc_bank_investments_creator_idx on public.sc_bank_investments (creator_id);

-- 預け入れ・引き出しの操作（ポイントの動きと銀行の残高を、途中で止まっても合わせるための記録）
-- status: pending（途中）/ done（完了）/ failed（失敗。引き出しは残高へ戻している）
create table if not exists public.sc_bank_ops (
  id uuid primary key,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  kind text not null check (kind in ('deposit', 'withdraw')),
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sc_bank_ops_pending_idx on public.sc_bank_ops (user_id) where status = 'pending';

-- 取引の履歴（利息は毎回書かず、口座の利息で表す）
create table if not exists public.sc_bank_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.sc_users(id) on delete cascade,
  kind text not null check (kind in ('deposit', 'withdraw', 'invest', 'divest', 'dividend')),
  amount numeric(18, 6) not null check (amount > 0),
  creator_id uuid references public.sc_users(id) on delete set null,
  payout_id uuid references public.sc_studio_payouts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sc_bank_events_user_idx on public.sc_bank_events (user_id, created_at desc);
create index if not exists sc_bank_events_creator_idx on public.sc_bank_events (creator_id, kind);

-- 作者の売上の内訳（配当で差し引いた額を、作者画面で見られるように）
alter table public.sc_studio_payouts add column if not exists gross_amount integer;
alter table public.sc_studio_payouts add column if not exists dividend_amount integer not null default 0;

alter table public.sc_bank_accounts enable row level security;
alter table public.sc_bank_investments enable row level security;
alter table public.sc_bank_ops enable row level security;
alter table public.sc_bank_events enable row level security;

-- ---------------------------------------------------------------
-- 利息の確定・残高の操作（内部用。呼び出し側で同じ取引の中から使う）
-- ---------------------------------------------------------------

-- 口座を用意し、前回から今までの利息（元本 × 日利 × 経過日数）を確定する。口座の行はロックされる。
create or replace function public.sc_bank_accrue(p_user uuid, p_daily_rate numeric)
returns void
language plpgsql
as $$
declare
  acc record;
  gained numeric := 0;
begin
  insert into public.sc_bank_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  select principal, last_accrued_at into acc
  from public.sc_bank_accounts where user_id = p_user for update;

  if acc.principal > 0 and p_daily_rate > 0 then
    gained := acc.principal * p_daily_rate
      * greatest(extract(epoch from (now() - acc.last_accrued_at))::numeric, 0) / 86400;
  end if;

  update public.sc_bank_accounts
  set earned_interest = earned_interest + gained, last_accrued_at = now()
  where user_id = p_user;
end
$$;

-- 元本に入れる（口座はロック済みで、利息は確定済みであること）
create or replace function public.sc_bank_credit(p_user uuid, p_amount numeric)
returns void
language sql
as $$
  update public.sc_bank_accounts set principal = principal + p_amount where user_id = p_user;
$$;

-- 残高から引く。利息から先に引き、足りなければ元本から引く（口座はロック済み・利息確定済みであること）
create or replace function public.sc_bank_take(p_user uuid, p_amount numeric)
returns void
language plpgsql
as $$
declare
  acc record;
begin
  select principal, earned_interest into acc
  from public.sc_bank_accounts where user_id = p_user for update;

  if acc.principal + acc.earned_interest < p_amount then
    raise exception 'insufficient' using errcode = 'P0001';
  end if;

  if acc.earned_interest >= p_amount then
    update public.sc_bank_accounts set earned_interest = earned_interest - p_amount where user_id = p_user;
  else
    update public.sc_bank_accounts
    set principal = principal - (p_amount - acc.earned_interest), earned_interest = 0
    where user_id = p_user;
  end if;
end
$$;

-- ---------------------------------------------------------------
-- 投資・投資の引き上げ（作者ごとのロック → 口座の順）
-- ---------------------------------------------------------------

create or replace function public.sc_bank_invest(p_user uuid, p_creator uuid, p_amount integer, p_daily_rate numeric)
returns text
language plpgsql
as $$
declare
  have numeric;
begin
  if p_user = p_creator then
    return 'self';
  end if;
  perform pg_advisory_xact_lock(hashtext('bank-creator:' || p_creator::text));
  perform public.sc_bank_accrue(p_user, p_daily_rate);

  select principal + earned_interest into have
  from public.sc_bank_accounts where user_id = p_user;
  if have < p_amount then
    return 'insufficient';
  end if;

  perform public.sc_bank_take(p_user, p_amount);
  insert into public.sc_bank_investments (user_id, creator_id, amount)
  values (p_user, p_creator, p_amount)
  on conflict (user_id, creator_id)
  do update set amount = sc_bank_investments.amount + excluded.amount, updated_at = now();

  insert into public.sc_bank_events (user_id, kind, amount, creator_id)
  values (p_user, 'invest', p_amount, p_creator);
  return 'ok';
end
$$;

create or replace function public.sc_bank_divest(p_user uuid, p_creator uuid, p_amount integer, p_daily_rate numeric)
returns text
language plpgsql
as $$
declare
  cur integer;
begin
  perform pg_advisory_xact_lock(hashtext('bank-creator:' || p_creator::text));
  perform public.sc_bank_accrue(p_user, p_daily_rate);

  select amount into cur
  from public.sc_bank_investments
  where user_id = p_user and creator_id = p_creator
  for update;
  if cur is null or cur < p_amount then
    return 'insufficient';
  end if;

  if cur = p_amount then
    delete from public.sc_bank_investments where user_id = p_user and creator_id = p_creator;
  else
    update public.sc_bank_investments
    set amount = amount - p_amount, updated_at = now()
    where user_id = p_user and creator_id = p_creator;
  end if;

  perform public.sc_bank_credit(p_user, p_amount);
  insert into public.sc_bank_events (user_id, kind, amount, creator_id)
  values (p_user, 'divest', p_amount, p_creator);
  return 'ok';
end
$$;

-- ---------------------------------------------------------------
-- 預け入れ（ポイントを減らしたあとに、銀行へ入れる）
-- ---------------------------------------------------------------

-- 途中（pending）の預け入れを完了にして、元本に入れる。完了済みなら何もしない（二重には入らない）。
create or replace function public.sc_bank_settle_deposit(p_op uuid, p_daily_rate numeric)
returns text
language plpgsql
as $$
declare
  op record;
begin
  select id, user_id, amount, status into op
  from public.sc_bank_ops where id = p_op for update;
  if not found then
    return 'missing';
  end if;
  if op.status <> 'pending' then
    return op.status;
  end if;

  perform public.sc_bank_accrue(op.user_id, p_daily_rate);
  perform public.sc_bank_credit(op.user_id, op.amount);
  update public.sc_bank_ops set status = 'done', updated_at = now() where id = p_op;
  insert into public.sc_bank_events (user_id, kind, amount) values (op.user_id, 'deposit', op.amount);
  return 'done';
end
$$;

-- ---------------------------------------------------------------
-- 引き出し（銀行から減らして pending にし、ポイントを返してから完了にする）
-- ---------------------------------------------------------------

-- 同じ操作IDが既にあれば、その今の状態を返す（再送しても二重には減らない）。
-- 残高が足りなければ 'insufficient'。新しく始めたら 'started'。
create or replace function public.sc_bank_withdraw_begin(p_op uuid, p_user uuid, p_amount integer, p_daily_rate numeric)
returns text
language plpgsql
as $$
declare
  existing text;
  have numeric;
begin
  select status into existing
  from public.sc_bank_ops where id = p_op and user_id = p_user;
  if found then
    return existing;
  end if;

  perform public.sc_bank_accrue(p_user, p_daily_rate);
  select principal + earned_interest into have
  from public.sc_bank_accounts where user_id = p_user;
  if have < p_amount then
    return 'insufficient';
  end if;

  perform public.sc_bank_take(p_user, p_amount);
  insert into public.sc_bank_ops (id, user_id, kind, amount, status)
  values (p_op, p_user, 'withdraw', p_amount, 'pending');
  return 'started';
end
$$;

-- 引き出しの結果を確定する。成功なら done。失敗なら残高へ戻して failed（pending のものだけ）。
create or replace function public.sc_bank_withdraw_finish(p_op uuid, p_ok boolean, p_daily_rate numeric)
returns text
language plpgsql
as $$
declare
  op record;
begin
  select id, user_id, amount, status into op
  from public.sc_bank_ops where id = p_op for update;
  if not found then
    return 'missing';
  end if;
  if op.status <> 'pending' then
    return op.status;
  end if;

  if p_ok then
    update public.sc_bank_ops set status = 'done', updated_at = now() where id = p_op;
    insert into public.sc_bank_events (user_id, kind, amount) values (op.user_id, 'withdraw', op.amount);
    return 'done';
  end if;

  perform public.sc_bank_accrue(op.user_id, p_daily_rate);
  perform public.sc_bank_credit(op.user_id, op.amount);
  update public.sc_bank_ops set status = 'failed', updated_at = now() where id = p_op;
  return 'failed';
end
$$;

-- ---------------------------------------------------------------
-- 売上の記録（配当を差し引いて、作者への支払いを作る）
-- ---------------------------------------------------------------

-- p_gross: 購入額（全額）。配当は floor(p_gross × p_dividend_rate)。
-- 作者の投資家に、投資額の割合（切り捨て）で配る。端数は作者に残す。
-- 作者の支払い（sc_studio_payouts）の amount は、配当を引いた額になる。
-- 同じ購入（または拡張機能の支払い）は二重に記録しない。戻り値: {"created": bool, "withheld": int}
create or replace function public.sc_bank_record_sale(
  p_payout uuid,
  p_creator uuid,
  p_work uuid,
  p_purchase uuid,
  p_charge uuid,
  p_gross integer,
  p_dividend_rate numeric,
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

  pool := floor(p_gross * p_dividend_rate);
  select coalesce(sum(amount), 0) into total
  from public.sc_bank_investments where creator_id = p_creator;

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

-- ---------------------------------------------------------------
-- 預かり金額のランキング（預金＋利息（今まで分）＋投資額）
-- 上位 p_limit 人と、p_user の順位を返す。名前を出さない人は show_name = false
-- ---------------------------------------------------------------
create or replace function public.sc_bank_ranking(p_daily_rate numeric, p_limit integer, p_user uuid)
returns table (
  r_user_id uuid,
  r_total numeric,
  r_position bigint,
  r_show_name boolean
)
language plpgsql
stable
as $$
begin
  return query
  with totals as (
    select
      a.user_id,
      a.show_name,
      a.principal + a.earned_interest
        + a.principal * p_daily_rate
          * greatest(extract(epoch from (now() - a.last_accrued_at))::numeric, 0) / 86400
        + coalesce((select sum(i.amount) from public.sc_bank_investments i where i.user_id = a.user_id), 0)
        as total
    from public.sc_bank_accounts a
  ),
  ranked as (
    select t.user_id, t.show_name, t.total,
           rank() over (order by t.total desc)::bigint as pos
    from totals t
    where t.total > 0
  )
  select ranked.user_id, ranked.total, ranked.pos, ranked.show_name
  from ranked
  where ranked.pos <= p_limit or ranked.user_id = p_user
  order by ranked.pos, ranked.user_id;
end
$$;
