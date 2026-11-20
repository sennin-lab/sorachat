-- v23: グループ通話のセキュリティ強化
-- 呼び出し（callin:）はサーバーだけが送れるようにし、クライアントからの送信権限を外します。
-- v2 の DM 向け call: 権限（相手のユーザーID宛て）も使わないので外します。何度実行しても安全です。

drop policy if exists sc_call_ring_insert on realtime.messages;
drop policy if exists sc_call_insert on realtime.messages;
drop policy if exists sc_call_select on realtime.messages;
