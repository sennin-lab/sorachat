-- v32: senningames のゲームを増やす（風船割り ハード・リズムタップ・数字つなぎ・星キャッチ）
-- 何度実行しても安全です。v31 の後に実行してください。
--
-- ・ゲームの結果（sc_solo_rounds.game）に、新しいゲームの名前を足す。
--   名前は server/senningames.ts の SOLO_GAMES のキーと同じにする（ここを変えたら、あちらも必ず合わせる）
-- ・ポイントの計算や残高の処理は変えない（v31 のまま）

alter table public.sc_solo_rounds drop constraint if exists sc_solo_rounds_game_check;
alter table public.sc_solo_rounds
  add constraint sc_solo_rounds_game_check
  check (game in ('balloon', 'balloon_hard', 'whack', 'stop', 'memory', 'rhythm', 'numbers', 'catch'));
