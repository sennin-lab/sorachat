// senningames：1人で遊んで、ポイントをためるゲーム。ためたポイントは 200pt ずつ仙人アカウントのポイントへ出金できる。
//
// ・ゲームごとに、1つ（風船1個・もぐら1匹など）あたりのポイントは決まっている（SOLO_GAMES）。
//   ラウンド（30秒）が終わったら、遊んだ数（units）だけを報告する。ポイントはサーバーで計算する（画面からは送らない）。
// ・同じゲームのラウンドは、前の報告から ROUND_MIN_INTERVAL_MS 以上あけないと加算されない（連続での水増しを防ぐ）。
// ・残高は sc_solo_wallets に、ミリポイント（1pt = 1000）で持つ。計算と記録は DB の関数（supabase/schema_v31.sql）で、1つのまとまりとして行う。
// ・出金は 200pt 単位。仙人アカウントへの加算は idempotency_key（solo-withdraw-出金ID）で行うので、再送しても二重には入らない。
//   仙人アカウント側で確実に失敗したとき（連携切れ・権限・上限など）は、減らしたポイントを残高へ戻す。
import { Router, type Response } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "./auth.js";
import { sb } from "./supabase.js";
import { adjustPoints, DEFINITE_FAILURE, isLinked, SenninError } from "./senninPoints.js";

export const senningames = Router();
senningames.use("/senningames", requireAuth);

// ゲームの中身（ポイントの単位もここで決める）。pointsMilli は 1つあたりのミリポイント（0.03pt = 30）
// 風船割りのハードは、ふつうの 5倍のポイント（1個 0.15pt）。
// ゲームを増やすときは、ここに足したうえで、supabase/schema_v32.sql のような移行（sc_solo_rounds.game の制約）も行う。
export const SOLO_GAMES = {
  balloon: { label: "風船割り", description: "ふくらんだ風船を割る。1個割るごとに加算", unit: "個", pointsMilli: 30, maxPerRound: 150 },
  balloon_hard: { label: "風船割り ハード", description: "小さく速い風船。ふつうの5倍のポイント", unit: "個", pointsMilli: 150, maxPerRound: 150 },
  whack: { label: "もぐらたたき", description: "顔を出したもぐらを叩く。1匹ごとに加算", unit: "匹", pointsMilli: 20, maxPerRound: 60 },
  stop: { label: "ストップ", description: "動くバーを的の中で止める。成功するごとに加算", unit: "回", pointsMilli: 50, maxPerRound: 40 },
  memory: { label: "神経衰弱", description: "同じ絵柄のカードをそろえる。1組そろえるごとに加算", unit: "組", pointsMilli: 100, maxPerRound: 40 },
  rhythm: { label: "リズムタップ", description: "流れてくる音符を、線に合わせてタップ。1つ合わせるごとに加算", unit: "回", pointsMilli: 25, maxPerRound: 80 },
  numbers: { label: "数字つなぎ", description: "1から順に、数字をできるだけ速くタップ。1組そろえるごとに加算", unit: "組", pointsMilli: 120, maxPerRound: 30 },
  catch: { label: "星キャッチ", description: "落ちてくる星をタップ。爆弾は取らない（加算されない）", unit: "個", pointsMilli: 20, maxPerRound: 120 }
} as const;
export type SoloGame = keyof typeof SOLO_GAMES;
const GAME_KEYS = Object.keys(SOLO_GAMES) as [SoloGame, ...SoloGame[]];

export const WITHDRAW_POINTS = 200;
const MILLI_PER_POINT = 1000;
const WITHDRAW_MILLI = WITHDRAW_POINTS * MILLI_PER_POINT;
const ROUND_MIN_INTERVAL_MS = 20_000;

type WalletRow = { milli_points: number; total_milli: number; withdrawn_milli: number };

async function readWallet(userId: string): Promise<WalletRow> {
  const { data, error } = await sb
    .from("sc_solo_wallets")
    .select("milli_points, total_milli, withdrawn_milli")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as WalletRow | null) ?? { milli_points: 0, total_milli: 0, withdrawn_milli: 0 };
}

const points = (milli: number) => milli / MILLI_PER_POINT;

function stateOf(wallet: WalletRow, linked: boolean) {
  return {
    points: points(wallet.milli_points),
    totalPoints: points(wallet.total_milli),
    withdrawnPoints: points(wallet.withdrawn_milli),
    linked,
    withdrawPoints: WITHDRAW_POINTS,
    canWithdraw: linked && wallet.milli_points >= WITHDRAW_MILLI,
    games: GAME_KEYS.map((id) => {
      const game = SOLO_GAMES[id];
      return {
        id,
        label: game.label,
        description: game.description,
        unit: game.unit,
        pointsPerUnit: points(game.pointsMilli),
        maxPerRound: game.maxPerRound
      };
    })
  };
}

// ---- 残高 ----

senningames.get("/senningames/state", async (_req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  try {
    const [wallet, linked] = await Promise.all([readWallet(me), isLinked(me)]);
    res.json({ ok: true, ...stateOf(wallet, linked) });
  } catch (error) {
    console.error("senningames の残高を読めませんでした", error);
    res.status(500).json({ ok: false, error: "残高を読み込めませんでした。時間をおいてお試しください。" });
  }
});

// ---- ラウンドの結果を加算する ----

const rewardBody = z.object({
  game: z.enum(GAME_KEYS),
  units: z.number().int().min(1).max(1000)
});

senningames.post("/senningames/reward", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const parsed = rewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "ゲームの結果を読めませんでした。" });
    return;
  }
  const { game, units } = parsed.data;
  const spec = SOLO_GAMES[game];
  if (units > spec.maxPerRound) {
    res.status(400).json({ ok: false, error: "1ラウンドで報告できる数を超えています。" });
    return;
  }
  try {
    const { data, error } = await sb.rpc("sc_solo_reward", {
      p_user: me,
      p_game: game,
      p_units: units,
      p_milli: units * spec.pointsMilli,
      p_min_interval_ms: ROUND_MIN_INTERVAL_MS
    });
    if (error) throw error;
    if (data === "cooldown") {
      res.status(429).json({ ok: false, error: "続けてラウンドを報告することはできません。少し待ってから遊んでください。" });
      return;
    }
    const wallet = await readWallet(me);
    res.json({ ok: true, added: points(units * spec.pointsMilli), ...stateOf(wallet, await isLinked(me)) });
  } catch (error) {
    console.error("senningames の加算に失敗しました", error);
    res.status(500).json({ ok: false, error: "ポイントを加算できませんでした。時間をおいてお試しください。" });
  }
});

// ---- 出金（200pt を仙人アカウントのポイントへ） ----

const withdrawBody = z.object({ requestId: z.string().uuid() });

// 仙人アカウント関連の失敗を、画面に返す形に変える。
// 502 は「入ったか分からない」（同じ出金IDで押し直すと、確かめてから完了する）。それ以外は確実に入っていない。
function sendWithdrawError(res: Response, error: unknown) {
  if (!(error instanceof SenninError)) throw error;
  const status =
    error.code === "not_linked" || error.code === "scope"
      ? 403
      : error.code === "invalid"
        ? 400
        : error.code === "insufficient_points"
          ? 409
          : error.code === "daily_limit"
            ? 429
            : 502;
  res.status(status).json({ ok: false, error: error.message, code: error.code, needsLink: error.code === "not_linked" });
}

senningames.post("/senningames/withdraw", async (req, res) => {
  const me = currentUserId(res);
  res.set("Cache-Control", "no-store");
  const parsed = withdrawBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "出金の内容を読めませんでした。" });
    return;
  }
  const requestId = parsed.data.requestId;
  try {
    if (!(await isLinked(me))) {
      res.status(403).json({ ok: false, code: "not_linked", needsLink: true, error: "出金するには、仙人アカウントと連携してください。" });
      return;
    }

    // 出金を始める（残高を減らし、出金の記録を作る。同じ出金IDなら今の状態を返すだけ）
    const { data: begun, error: beginError } = await sb.rpc("sc_solo_begin_withdraw", {
      p_user: me,
      p_request: requestId,
      p_points: WITHDRAW_POINTS,
      p_milli: WITHDRAW_MILLI
    });
    if (beginError) throw beginError;
    if (begun === "insufficient") {
      res.status(400).json({ ok: false, error: `出金は ${WITHDRAW_POINTS}pt からできます。もう少し遊んでから、もう一度お試しください。` });
      return;
    }
    if (begun === "completed") {
      res.json({ ok: true, withdrawn: WITHDRAW_POINTS, ...stateOf(await readWallet(me), true) });
      return;
    }
    if (begun === "refunded") {
      res.status(400).json({ ok: false, error: "この出金は、仙人アカウントへ入らなかったため取り消されました。" });
      return;
    }

    // 仙人アカウントへ加算する（pending のときは、同じ出金IDで何度でも再送できる）
    try {
      await adjustPoints(me, {
        amount: WITHDRAW_POINTS,
        reason: "senningames からの出金",
        idempotencyKey: `solo-withdraw-${requestId}`
      });
    } catch (error) {
      // 確実に入らなかったと分かったときだけ、減らしたポイントを戻して記録を閉じる
      if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
        await sb.rpc("sc_solo_settle_withdraw", { p_user: me, p_request: requestId, p_status: "refunded", p_milli: WITHDRAW_MILLI });
      }
      // 入ったか分からないときは pending のまま残す（同じ出金IDで押し直すと、確かめてから完了する）
      throw error;
    }
    const { error: settleError } = await sb.rpc("sc_solo_settle_withdraw", {
      p_user: me,
      p_request: requestId,
      p_status: "completed",
      p_milli: 0
    });
    if (settleError) console.error("senningames の出金の完了を記録できませんでした", settleError);
    res.json({ ok: true, withdrawn: WITHDRAW_POINTS, ...stateOf(await readWallet(me), true) });
  } catch (error) {
    sendWithdrawError(res, error);
  }
});
