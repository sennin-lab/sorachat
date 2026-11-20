-- SoraChat: 管理者パネルのシステム設定（メンテナンスモード）
create table if not exists public.sc_system_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sc_system_settings enable row level security;
-- アプリサーバーは Supabase service_role key でアクセスします。
-- クライアント向けの anon/authenticated ポリシーは作成しません。
