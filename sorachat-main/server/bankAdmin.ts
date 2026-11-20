// SenninBank の管理者機能（管理者パネルからだけ使う。requireAdmin で守る）
//  ・銀行の一時停止・再開（止めている間は、預け入れ・引き出し・投資・配当の操作を受け付けない）
//  ・利率の変更（日利・配当率の下限・上限）。空に戻すと、環境変数（BANK_*）の値になる
//  ・銀行の状況（口座数・預金・利息・投資・配当の合計）と、最近の出来事
// 設定は sc_system_settings（setting_key = 'bank'）に保存し、起動時に読み込む。利率と停止は次の操作から反映される。
import { Router, type Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { sb } from "./supabase.js";
import { bankRates, getBankOverrides, readRate, setBankOverrides, type BankOverrides } from "./bankRules.js";

export const bankAdmin = Router();
bankAdmin.use("/admin/bank", requireAdmin);

const SETTING_KEY = "bank";

// 起動時に、保存された設定を読み込む（読めなければ、環境変数の値のまま動く）
export async function initializeBankSettings() {
  const { data, error } = await sb
    .from("sc_system_settings")
    .select("setting_value")
    .eq("setting_key", SETTING_KEY)
    .maybeSingle();
  if (error) {
    console.warn("SenninBank の設定をDBから読み込めませんでした。環境変数の値を使用します。", error.message);
    return;
  }
  const value = data?.setting_value as Partial<BankOverrides> | null;
  if (!value || typeof value !== "object") return;
  const rate = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 ? x : null);
  setBankOverrides({
    paused: value.paused === true,
    dailyRate: rate(value.dailyRate),
    dividendRate: rate(value.dividendRate),
    dividendMaxRate: rate(value.dividendMaxRate)
  });
}

async function saveOverrides(next: BankOverrides) {
  const { error } = await sb
    .from("sc_system_settings")
    .upsert({ setting_key: SETTING_KEY, setting_value: next, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });
  if (error) throw new Error("SenninBank の設定を保存できませんでした。SupabaseのSQLを適用してください。");
  setBankOverrides(next);
}

// 環境変数の既定値（空欄のときに使われる値）
const envDefaults = () => ({
  dividendRate: readRate(process.env.BANK_DIVIDEND_RATE, 0.1, 0.5),
  dividendMaxRate: readRate(process.env.BANK_DIVIDEND_MAX_RATE, 0.3, 0.5)
});

// 画面からの入力は「%」で受け取る（例：0.02 = 0.02%/日）。空（null）は環境変数の値に戻す
const settingsBody = z.object({
  paused: z.boolean(),
  dailyPercent: z.number().min(0).max(1).nullable(),
  dividendPercent: z.number().min(0).max(50).nullable(),
  dividendMaxPercent: z.number().min(0).max(50).nullable()
});

const num = (value: unknown) => Number(value ?? 0);

function sendError(res: Response, error: unknown) {
  console.error("[bank-admin] 管理者の銀行の処理でエラー:", error);
  res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "銀行の処理でエラーが発生しました。" });
}

bankAdmin.get("/admin/bank", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const [accountRes, investRes, dividendRes, eventRes, pendingRes] = await Promise.all([
      sb.from("sc_bank_accounts").select("principal, earned_interest"),
      sb.from("sc_bank_investments").select("amount"),
      sb.from("sc_bank_events").select("amount").eq("kind", "dividend"),
      sb.from("sc_bank_events").select("id, user_id, kind, amount, creator_id, created_at").order("created_at", { ascending: false }).limit(50),
      sb.from("sc_bank_ops").select("id", { count: "exact", head: true }).eq("status", "pending")
    ]);
    for (const r of [accountRes, investRes, dividendRes, eventRes, pendingRes]) {
      if (r.error) throw r.error;
    }

    const accounts = (accountRes.data ?? []) as { principal: number; earned_interest: number }[];
    const invests = (investRes.data ?? []) as { amount: number }[];
    const dividends = (dividendRes.data ?? []) as { amount: number }[];
    const events = (eventRes.data ?? []) as { id: number; user_id: string; kind: string; amount: number; creator_id: string | null; created_at: string }[];

    // 出来事に出てくる人の名前をまとめて引く（空のときも同じ形の問い合わせにする）
    const ids = [...new Set(events.flatMap((e) => [String(e.user_id), e.creator_id ? String(e.creator_id) : null]).filter((x): x is string => Boolean(x)))];
    const userRes = await sb.from("sc_users").select("id, display_name").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    if (userRes.error) throw userRes.error;
    const nameOf = new Map(((userRes.data ?? []) as { id: string; display_name: string }[]).map((u) => [String(u.id), String(u.display_name)]));

    const rates = bankRates();
    const overrides = getBankOverrides();
    const env = envDefaults();
    const toPercent = (x: number | null) => (x === null ? null : x * 100);
    res.set("Cache-Control", "no-store").json({
      ok: true,
      paused: overrides.paused,
      rates: {
        dailyPercent: rates.dailyRate * 100,
        dividendPercent: rates.dividendRate * 100,
        dividendMaxPercent: rates.dividendMaxRate * 100
      },
      // 管理者が決めた値（null は環境変数の値を使っている）
      overrides: {
        dailyPercent: toPercent(overrides.dailyRate),
        dividendPercent: toPercent(overrides.dividendRate),
        dividendMaxPercent: toPercent(overrides.dividendMaxRate)
      },
      envDefaults: {
        dailyPercent: readRate(process.env.BANK_DAILY_RATE, 0.0002, 0.01) * 100,
        dividendPercent: env.dividendRate * 100,
        dividendMaxPercent: env.dividendMaxRate * 100
      },
      stats: {
        accounts: accounts.length,
        principal: accounts.reduce((s, a) => s + num(a.principal), 0),
        interest: accounts.reduce((s, a) => s + num(a.earned_interest), 0),
        invested: invests.reduce((s, r) => s + num(r.amount), 0),
        dividends: dividends.reduce((s, r) => s + num(r.amount), 0),
        pendingOps: pendingRes.count ?? 0
      },
      events: events.map((e) => ({
        id: String(e.id),
        kind: e.kind,
        amount: num(e.amount),
        userName: nameOf.get(String(e.user_id)) ?? "ユーザー",
        creatorName: e.creator_id ? (nameOf.get(String(e.creator_id)) ?? "開発者") : null,
        createdAt: e.created_at
      }))
    });
  } catch (error) {
    sendError(res, error);
  }
});

bankAdmin.put("/admin/bank/settings", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parsed = settingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "設定の内容を確かめてください。" });
    return;
  }
  const b = parsed.data;
  const env = envDefaults();
  const dividend = (b.dividendPercent ?? env.dividendRate * 100) / 100;
  const dividendMax = (b.dividendMaxPercent ?? env.dividendMaxRate * 100) / 100;
  if (dividendMax < dividend) {
    res.status(400).json({ ok: false, error: "配当率の上限は、下限以上にしてください。" });
    return;
  }
  const next: BankOverrides = {
    paused: b.paused,
    dailyRate: b.dailyPercent === null ? null : b.dailyPercent / 100,
    dividendRate: b.dividendPercent === null ? null : b.dividendPercent / 100,
    dividendMaxRate: b.dividendMaxPercent === null ? null : b.dividendMaxPercent / 100
  };
  try {
    await saveOverrides(next);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});
