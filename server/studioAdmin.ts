// senninstudio の管理者 API（管理者パネルからだけ使う。requireAdmin で守る）
// 作者ができない操作（公開停止・復帰・削除・作者の停止・支払いの再送・通報の確認）をここで行う。
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { readImage } from "./media.js";
import { requireAdmin } from "./admin.js";
import { sb } from "./supabase.js";
import { retryPayout } from "./studioPayout.js";
import { imagesByWork, WORK_PREFIX } from "./studioData.js";
import { ExtensionError, readExtensionGrant, setCertifiedCreator, setExtensionGrant } from "./extensionPoints.js";

export const studioAdmin = Router();
studioAdmin.use("/admin/studio", requireAdmin);

const UUID = /^[0-9a-f-]{36}$/i;

const idParam = (req: Request, res: Response): string | null => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ error: "見つかりません。" });
    return null;
  }
  return id;
};

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (!unique.length) return map;
  const { data, error } = await sb.from("sc_users").select("id, display_name, username").in("id", unique);
  if (error) throw error;
  for (const row of data ?? []) map.set(row.id as string, `${row.display_name as string}（@${row.username as string}）`);
  return map;
}

// 作品の一覧（状態で絞る。通報の件数と販売数を付ける）
studioAdmin.get("/admin/studio/works", async (req, res) => {
  const status = String(req.query.status ?? "all");
  const q = String(req.query.q ?? "").trim().slice(0, 40);
  let query = sb
    .from("sc_studio_works")
    .select("id, creator_id, kind, name, price, status, hidden_reason, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (["published", "hidden", "deleted", "removed"].includes(status)) query = query.eq("status", status);
  if (q) query = query.ilike("name", `%${q.replace(/[%_,]/g, "")}%`);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const ids = rows.map((r) => r.id as string);

  const reports = new Map<string, number>();
  const sales = new Map<string, number>();
  if (ids.length) {
    const [reportRows, saleRows] = await Promise.all([
      sb.from("sc_studio_reports").select("work_id").in("work_id", ids),
      sb.from("sc_store_items").select("item_id").in("item_id", ids.map((id) => `${WORK_PREFIX}${id}`))
    ]);
    for (const r of reportRows.data ?? []) reports.set(r.work_id as string, (reports.get(r.work_id as string) ?? 0) + 1);
    for (const s of saleRows.data ?? []) {
      const id = (s.item_id as string).slice(WORK_PREFIX.length);
      sales.set(id, (sales.get(id) ?? 0) + 1);
    }
  }
  const names = await namesOf(rows.map((r) => r.creator_id as string));
  res.json(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      price: r.price,
      status: r.status,
      hiddenReason: r.hidden_reason,
      creatorId: r.creator_id,
      creatorName: names.get(r.creator_id as string) ?? "",
      reportCount: reports.get(r.id as string) ?? 0,
      sales: sales.get(r.id as string) ?? 0,
      createdAt: r.created_at
    }))
  );
});

// 作品の詳細（説明・画像・通報の内容・作者の状態）
studioAdmin.get("/admin/studio/works/:id", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { data: work, error } = await sb
    .from("sc_studio_works")
    .select("id, creator_id, kind, name, description, price, status, hidden_reason, payload, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!work) {
    res.status(404).json({ error: "作品が見つかりません。" });
    return;
  }
  const [images, reportRows, creatorRow, names] = await Promise.all([
    imagesByWork([id]),
    sb.from("sc_studio_reports").select("reporter_id, reason, created_at").eq("work_id", id).order("created_at", { ascending: false }),
    sb.from("sc_studio_creators").select("suspended, suspended_reason, certified").eq("user_id", work.creator_id as string).maybeSingle(),
    namesOf([work.creator_id as string])
  ]);
  const reporterNames = await namesOf((reportRows.data ?? []).map((r) => r.reporter_id as string));
  res.json({
    id: work.id,
    kind: work.kind,
    name: work.name,
    description: work.description,
    price: work.price,
    status: work.status,
    hiddenReason: work.hidden_reason,
    payload: work.payload,
    createdAt: work.created_at,
    images: (images.get(id) ?? []).map((i) => ({ id: i.id, role: i.role })),
    creator: {
      id: work.creator_id,
      name: names.get(work.creator_id as string) ?? "",
      suspended: Boolean(creatorRow.data?.suspended),
      suspendedReason: (creatorRow.data?.suspended_reason as string | null) ?? null,
      certified: Boolean(creatorRow.data?.certified)
    },
    reports: (reportRows.data ?? []).map((r) => ({
      reporterName: reporterNames.get(r.reporter_id as string) ?? "",
      reason: r.reason,
      createdAt: r.created_at
    })),
    // 拡張機能のときだけ、ポイント配布の上限（管理者が決める）を返す
    grant: work.kind === "extension" ? await readExtensionGrant(id) : null
  });
});

// 拡張機能からのポイント配布の上限を決める。0 にするか active を false にすると、配布は止まる
// perUserMinuteMax：1人が1分間に受け取れるポイントの上限（0 は制限なし。省略すると今の値を残す）
const grantSchema = z.object({
  maxPoints: z.number().int().min(0).max(10_000_000),
  active: z.boolean(),
  perUserMinuteMax: z.number().int().min(0).max(10_000_000).optional(),
  // 1回に配れる上限（pt）。固定の上限はなく、管理者が決める（1以上・DBの整数の範囲まで）
  perCallMax: z.number().int().min(1).max(2_147_483_647).optional()
});
studioAdmin.put("/admin/studio/works/:id/grant", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "配れるポイントと1分あたりの上限は 0 以上の整数で、有効かどうかも指定してください。" });
    return;
  }
  try {
    res.json({ ok: true, grant: await setExtensionGrant(id, parsed.data) });
  } catch (error) {
    if (error instanceof ExtensionError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

const statusSchema = z.object({
  status: z.enum(["published", "hidden", "removed"]),
  reason: z.string().max(200).optional()
});

// 公開・非公開・削除を切り替える。公開に戻すときは通報の記録も消して、数え直す
studioAdmin.post("/admin/studio/works/:id/status", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "状態を選んでください。" });
    return;
  }
  const { status } = parsed.data;
  if (status === "published") {
    const { data: work } = await sb.from("sc_studio_works").select("creator_id").eq("id", id).maybeSingle();
    if (!work) {
      res.status(404).json({ error: "作品が見つかりません。" });
      return;
    }
    const { data: creator } = await sb.from("sc_studio_creators").select("suspended").eq("user_id", work.creator_id as string).maybeSingle();
    if (creator?.suspended) {
      res.status(400).json({ error: "この作者は停止中です。先に作者の停止を解除してください。" });
      return;
    }
    await sb.from("sc_studio_reports").delete().eq("work_id", id);
  }
  const { error } = await sb
    .from("sc_studio_works")
    .update({
      status,
      hidden_reason: status === "published" ? null : "admin",
      updated_at: new Date().toISOString()
    })
    .eq("id", id);
  if (error) throw error;
  res.json({ ok: true });
});

// 通報の記録を消す（作品は今の状態のまま。次の通報から数え直す）
studioAdmin.post("/admin/studio/works/:id/dismiss-reports", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { error } = await sb.from("sc_studio_reports").delete().eq("work_id", id);
  if (error) throw error;
  res.json({ ok: true });
});

// 作品の画像（管理者の確認用）
studioAdmin.get("/admin/studio/images/:id", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { data, error } = await sb.from("sc_studio_images").select("path").eq("id", id).maybeSingle();
  if (error) throw error;
  const image = data ? await readImage(data.path as string) : null;
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader("content-type", image.type);
  res.setHeader("cache-control", "no-store");
  res.send(image.buffer);
});

const certifiedSchema = z.object({ certified: z.boolean() });

// 認定開発者の指定・解除。認定の作者の拡張機能は、1回に払わせられる上限が高くなる（隔離は変わらない）
studioAdmin.post("/admin/studio/creators/:userId/certified", async (req, res) => {
  const userId = String(req.params.userId);
  if (!UUID.test(userId)) {
    res.status(404).json({ error: "見つかりません。" });
    return;
  }
  const parsed = certifiedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "認定するか、外すかを選んでください。" });
    return;
  }
  try {
    res.json({ ok: true, ...(await setCertifiedCreator(userId, parsed.data.certified)) });
  } catch (error) {
    if (error instanceof ExtensionError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

const suspendSchema = z.object({ suspended: z.boolean(), reason: z.string().max(200).optional() });

// 作者の停止・解除。停止すると、その作者の販売中の作品も非公開になる（解除で戻る）
studioAdmin.post("/admin/studio/creators/:userId/suspend", async (req, res) => {
  const userId = String(req.params.userId);
  if (!UUID.test(userId)) {
    res.status(404).json({ error: "見つかりません。" });
    return;
  }
  const parsed = suspendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "操作を選んでください。" });
    return;
  }
  const { suspended } = parsed.data;
  const reason = parsed.data.reason?.trim() || null;
  const { error } = await sb.from("sc_studio_creators").upsert(
    { user_id: userId, suspended, suspended_reason: suspended ? reason : null },
    { onConflict: "user_id" }
  );
  if (error) throw error;
  const now = new Date().toISOString();
  if (suspended) {
    await sb
      .from("sc_studio_works")
      .update({ status: "hidden", hidden_reason: "creator_suspended", updated_at: now })
      .eq("creator_id", userId)
      .eq("status", "published");
  } else {
    await sb
      .from("sc_studio_works")
      .update({ status: "published", hidden_reason: null, updated_at: now })
      .eq("creator_id", userId)
      .eq("status", "hidden")
      .eq("hidden_reason", "creator_suspended");
  }
  res.json({ ok: true });
});

// 通報のある作品（新しい通報が多い順）
studioAdmin.get("/admin/studio/reports", async (_req, res) => {
  const { data, error } = await sb.from("sc_studio_reports").select("work_id, created_at").order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  const counts = new Map<string, { count: number; latest: string }>();
  for (const row of data ?? []) {
    const id = row.work_id as string;
    const entry = counts.get(id) ?? { count: 0, latest: row.created_at as string };
    entry.count += 1;
    counts.set(id, entry);
  }
  const ids = [...counts.keys()];
  if (!ids.length) {
    res.json([]);
    return;
  }
  const { data: works, error: worksError } = await sb
    .from("sc_studio_works")
    .select("id, name, kind, status, hidden_reason, creator_id")
    .in("id", ids);
  if (worksError) throw worksError;
  const names = await namesOf((works ?? []).map((w) => w.creator_id as string));
  res.json(
    (works ?? [])
      .map((w) => ({
        id: w.id,
        name: w.name,
        kind: w.kind,
        status: w.status,
        hiddenReason: w.hidden_reason,
        creatorName: names.get(w.creator_id as string) ?? "",
        reportCount: counts.get(w.id as string)?.count ?? 0,
        latestAt: counts.get(w.id as string)?.latest ?? ""
      }))
      .sort((a, b) => b.reportCount - a.reportCount)
  );
});

// 作者への支払いの一覧（状態で絞る）
studioAdmin.get("/admin/studio/payouts", async (req, res) => {
  const status = String(req.query.status ?? "pending");
  let query = sb
    .from("sc_studio_payouts")
    .select("id, creator_id, work_id, amount, status, attempts, last_error, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (["pending", "paid", "failed"].includes(status)) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const names = await namesOf(rows.map((r) => r.creator_id as string));
  const { data: works } = await sb
    .from("sc_studio_works")
    .select("id, name")
    .in("id", rows.map((r) => r.work_id as string));
  const workNames = new Map((works ?? []).map((w) => [w.id as string, w.name as string]));
  res.json(
    rows.map((r) => ({
      id: r.id,
      creatorName: names.get(r.creator_id as string) ?? "",
      workName: workNames.get(r.work_id as string) ?? "",
      amount: r.amount,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at
    }))
  );
});

// 支払いを払い直す（作者の連携が直っていれば払える）
studioAdmin.post("/admin/studio/payouts/:id/retry", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  try {
    await retryPayout(id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "支払いを再送できませんでした。" });
  }
});
