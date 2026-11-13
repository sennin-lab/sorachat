-- v40: 拡張機能の「1回に配れるポイント」の上限を、管理者が拡張機能ごとに決める（固定の500ptをやめる）
-- 何度実行しても安全です。v39 の後に実行してください。
--
-- ・sc_extension_grants.per_call_max：1回の配布の上限（pt）。初期値は 500（既存の拡張機能は今までどおり 500pt まで）
-- ・上限の確認は、配布の枠を使う前に行う（server/extensionPoints.ts）

alter table public.sc_extension_grants
  add column if not exists per_call_max integer not null default 500 check (per_call_max >= 1);
