-- v37: ミニゲームの種類に「連打バトル（tap）」「反射神経バトル（reflex）」を追加
-- 何度実行しても安全です。v36 の後に実行してください。
alter table public.sc_games drop constraint if exists sc_games_kind_check;
alter table public.sc_games add constraint sc_games_kind_check
  check (kind in ('tictactoe', 'quiz', 'janken', 'guess', 'tap', 'reflex'));
