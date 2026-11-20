-- v30: senninstudio で「拡張機能」（HTML・CSS・JavaScript で作るミニアプリ）を販売できるようにする
-- 何度実行しても安全です。v29 の後に実行してください。
--
-- ・作品の種類に extension を追加する（中身は payload の html / css / js。サーバーで検査して保存する）
-- ・買った人は、隔離した枠（sandbox）の中でだけ動かす。ソラチャットの画面・ログイン情報・通信には触れない
-- ・画像（サムネイルなど）はこれまでどおり Turso（sc_blobs）に保存する

alter table public.sc_studio_works drop constraint if exists sc_studio_works_kind_check;
alter table public.sc_studio_works
  add constraint sc_studio_works_kind_check
  check (kind in ('stamp_pack', 'theme', 'quiz', 'ai_style', 'extension'));
