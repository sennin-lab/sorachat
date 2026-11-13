// 拡張機能（senninstudio の作品）からの、ポイント配布と、利用者の情報の許可。
//
// ・枠の中の拡張機能は、ソラチャットの画面が取り次いだ依頼だけを、ここで受ける（ブリッジ）。
// ・配れるのは「その拡張機能を開いて、情報の許可をした本人」だけ。ほかの人には配れない。
// ・配れる量は管理者が決める（sc_extension_grants.max_points）。枠を超える配布は 409 で断る。
// ・配布の枠の確保と記録は DB の関数（sc_extension_reserve）で行い、仙人アカウントへの加算は
//   idempotency_key（ext-award-配布ID）で行う。同じ requestId で押し直しても二重には入らない。
// ・許可（sc_extension_consents）は、いつでも取り消せる。
import { canUseItem } from "./storeAccess.js";
import { loadWork, toStudioItem, type WorkRow } from "./studioData.js";
import { sb } from "./supabase.js";
import { adjustPoints, DEFINITE_FAILURE, isLinked, SenninError } from "./senninPoints.js";
import { recordSale } from "./studioPayout.js";
import { config } from "./config.js";
import { EXT_BRIDGE, EXT_TOTAL_MAX } from "./studioRules.js";
import { BATTLE } from "./battleRules.js";
import { STORAGE } from "./extensionStorageRules.js";

// 利用者が1分間に配布を頼める回数（連打・暴走の防止）
const AWARD_PER_MINUTE = 60;
// 利用者が1分間に支払いを頼める回数（確認画面を通すので、少なめ）
const CHARGE_PER_MINUTE = 20;

export class ExtensionError extends Error {
  status: number;
  code: string;
  remaining?: number;
  constructor(status: number, code: string, message: string, remaining?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.remaining = remaining;
  }
}

// 拡張機能の作品を読む（非公開・削除済みは開けない。買った人と作者は、非公開でも使える）
async function loadExtensionWork(workId: string): Promise<WorkRow> {
  const work = await loadWork(workId);
  if (!work || work.kind !== "extension" || work.status === "removed") {
    throw new ExtensionError(404, "not_found", "拡張機能が見つかりません。");
  }
  return work;
}

async function canOpen(me: string, work: WorkRow): Promise<boolean> {
  return work.creator_id === me || (await canUseItem(me, toStudioItem(work)));
}

async function hasConsent(me: string, workId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("sc_extension_consents")
    .select("user_id")
    .eq("user_id", me)
    .eq("work_id", workId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// ---- 利用者の情報の許可 ----

// 拡張機能を開いたときの状態。許可していなければ、アカウントの情報は一切返さない
export async function extensionAccess(me: string, workId: string) {
  const work = await loadExtensionWork(workId);
  if (!(await canOpen(me, work))) {
    throw new ExtensionError(403, "not_owned", "この拡張機能はまだ購入していません。");
  }
  const consented = await hasConsent(me, workId);
  const { data: grant, error: grantError } = await sb
    .from("sc_extension_grants")
    .select("max_points, used_points, active")
    .eq("work_id", workId)
    .maybeSingle();
  if (grantError) throw grantError;
  const grantInfo = grant && grant.active ? { remaining: Number(grant.max_points) - Number(grant.used_points) } : null;

  if (!consented) return { consented: false, grant: grantInfo };

  const { data: user, error: userError } = await sb
    .from("sc_users")
    .select("id, username, display_name, sennin_id")
    .eq("id", me)
    .maybeSingle();
  if (userError) throw userError;
  if (!user) throw new ExtensionError(404, "not_found", "アカウントが見つかりません。");
  const senninId = (user.sennin_id as string | null) ?? null;
  return {
    consented: true,
    grant: grantInfo,
    sorachat: {
      id: user.id as string,
      username: user.username as string,
      displayName: user.display_name as string
    },
    sennin: { linked: Boolean(senninId), senninId }
  };
}

// 許可する（情報を、この拡張機能に渡してよい）。買っていない人は許可できない
export async function grantExtensionConsent(me: string, workId: string) {
  const work = await loadExtensionWork(workId);
  if (!(await canOpen(me, work))) {
    throw new ExtensionError(403, "not_owned", "この拡張機能はまだ購入していません。");
  }
  const { error } = await sb.from("sc_extension_consents").upsert(
    { user_id: me, work_id: workId, granted_at: new Date().toISOString() },
    { onConflict: "user_id,work_id", ignoreDuplicates: true }
  );
  if (error) throw error;
}

// 許可を取り消す
export async function revokeExtensionConsent(me: string, workId: string) {
  const { error } = await sb.from("sc_extension_consents").delete().eq("user_id", me).eq("work_id", workId);
  if (error) throw error;
}

// ---- ポイントの配布 ----

// 配布の依頼を確かめる（範囲・理由の長さ・requestId の形）
export function checkAwardRequest(body: unknown): { ok: true; amount: number; reason: string; requestId: string } | { ok: false; error: string } {
  const v = (body ?? {}) as Record<string, unknown>;
  const amount = v.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < EXT_BRIDGE.awardMin || amount > EXT_BRIDGE.awardMaxPerCall) {
    return { ok: false, error: `配るポイントは ${EXT_BRIDGE.awardMin}〜${EXT_BRIDGE.awardMaxPerCall} の整数で指定してください。` };
  }
  const reason = typeof v.reason === "string" ? v.reason.trim() : "";
  if (reason.length > EXT_BRIDGE.reasonMax) {
    return { ok: false, error: `理由は ${EXT_BRIDGE.reasonMax} 文字までです。` };
  }
  const requestId = typeof v.requestId === "string" ? v.requestId : "";
  const idPattern = new RegExp(`^[A-Za-z0-9_-]{${EXT_BRIDGE.requestIdMin},${EXT_BRIDGE.requestIdMax}}$`);
  if (!idPattern.test(requestId)) {
    return { ok: false, error: `requestId は英数字・-・_ の ${EXT_BRIDGE.requestIdMin}〜${EXT_BRIDGE.requestIdMax} 文字で指定してください。` };
  }
  return { ok: true, amount, reason, requestId };
}

const awardHits = new Map<string, number[]>();
function awardAllowed(me: string): boolean {
  const now = Date.now();
  const recent = (awardHits.get(me) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= AWARD_PER_MINUTE) {
    awardHits.set(me, recent);
    return false;
  }
  recent.push(now);
  awardHits.set(me, recent);
  return true;
}

async function settleAward(awardId: string, status: "done" | "failed") {
  const { error } = await sb.rpc("sc_extension_settle", { p_award: awardId, p_status: status });
  if (error) throw error;
}

// 利用者に、拡張機能からポイントを配る。許可した本人にだけ、管理者の上限の中で配る
export async function awardExtensionPoints(
  me: string,
  workId: string,
  request: { amount: number; reason: string; requestId: string }
) {
  if (!awardAllowed(me)) {
    throw new ExtensionError(429, "rate_limited", "配布の依頼が多すぎます。少し待ってからお試しください。");
  }
  const work = await loadExtensionWork(workId);
  if (!(await canOpen(me, work))) {
    throw new ExtensionError(403, "not_owned", "この拡張機能はまだ購入していません。");
  }
  if (!(await hasConsent(me, workId))) {
    throw new ExtensionError(403, "not_consented", "アカウント情報の許可がありません。先に許可してください。");
  }
  if (!(await isLinked(me))) {
    throw new ExtensionError(403, "not_linked", "ポイントを受け取るには、仙人アカウントとの連携が必要です。");
  }

  const { data, error } = await sb.rpc("sc_extension_reserve", {
    p_user: me,
    p_work: workId,
    p_request: request.requestId,
    p_points: request.amount,
    p_reason: request.reason
  });
  if (error) throw error;
  const reserved = (data ?? {}) as {
    result: string;
    id?: string;
    status?: string;
    points?: number;
    remaining?: number;
    limit?: number;
  };

  if (reserved.result === "inactive") {
    throw new ExtensionError(403, "inactive", "この拡張機能は、ポイントを配る許可がありません。");
  }
  if (reserved.result === "exhausted") {
    const remaining = Number(reserved.remaining ?? 0);
    throw new ExtensionError(409, "exhausted", `この拡張機能が配れるポイントは、あと ${remaining}pt です。`, remaining);
  }
  if (reserved.result === "minute_exhausted") {
    const remaining = Math.max(0, Number(reserved.remaining ?? 0));
    const limit = Number(reserved.limit ?? 0);
    throw new ExtensionError(
      429,
      "minute_limit",
      `この拡張機能は、1人が1分間に受け取れるのは ${limit}pt までです。あと ${remaining}pt です。少し待ってからお試しください。`,
      remaining
    );
  }
  if (reserved.result === "exists" && reserved.status === "done") {
    return { awarded: Number(reserved.points), replayed: true, points: null as number | null };
  }
  if (reserved.result === "exists" && reserved.status === "failed") {
    throw new ExtensionError(409, "failed", "この配布は失敗しています。新しい requestId で、もう一度お試しください。");
  }

  // ここからは reserved（今回確保した、または前回の確保が途中で止まったもの）。同じ配布IDで加算するので二重にはならない
  const awardId = String(reserved.id);
  const points = Number(reserved.points);
  const label = `拡張機能「${work.name}」${request.reason ? `：${request.reason}` : ""}`.slice(0, 80);
  try {
    const result = await adjustPoints(me, { amount: points, reason: label, idempotencyKey: `ext-award-${awardId}` });
    await settleAward(awardId, "done");
    return { awarded: points, replayed: result.replayed, points: result.points };
  } catch (error) {
    if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
      // 確実に加算されなかった失敗だけ、枠を戻して失敗として閉じる
      await settleAward(awardId, "failed");
      const status = error.code === "scope" || error.code === "not_linked" ? 403 : error.code === "daily_limit" ? 429 : 409;
      throw new ExtensionError(status, error.code, error.message);
    }
    // 加算されたか分からない。枠は確保したままにし、同じ requestId で押し直せば確かめ直せる
    throw new ExtensionError(503, "unknown", "ポイントの配布結果を確かめられませんでした。同じ requestId で、もう一度お試しください。");
  }
}

// ---- 拡張機能の中の支払い（ポイント） ----
// 支払いは、ソラチャットの確認画面（利用者が押すまで払われない）を通ったときだけ、画面が取り次ぐ。
// 枠の中のコードは、この API を直接呼べない（通信禁止・sandbox）。金額と品名は、確認画面に出る値がそのまま払われる。

export function checkChargeRequest(body: unknown): { ok: true; amount: number; title: string; requestId: string } | { ok: false; error: string } {
  const v = (body ?? {}) as Record<string, unknown>;
  const amount = v.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < EXT_BRIDGE.chargeMin) {
    return { ok: false, error: `支払うポイントは ${EXT_BRIDGE.chargeMin} 以上の整数で指定してください。` };
  }
  const title = typeof v.title === "string" ? v.title.trim() : "";
  if (!title || title.length > EXT_BRIDGE.chargeTitleMax) {
    return { ok: false, error: `品名は 1〜${EXT_BRIDGE.chargeTitleMax} 文字で指定してください。` };
  }
  const requestId = typeof v.requestId === "string" ? v.requestId : "";
  const idPattern = new RegExp(`^[A-Za-z0-9_-]{${EXT_BRIDGE.requestIdMin},${EXT_BRIDGE.requestIdMax}}$`);
  if (!idPattern.test(requestId)) {
    return { ok: false, error: `requestId は英数字・-・_ の ${EXT_BRIDGE.requestIdMin}〜${EXT_BRIDGE.requestIdMax} 文字で指定してください。` };
  }
  return { ok: true, amount, title, requestId };
}

// 作者が認定開発者か（管理者が指定）。認定の有無で、1回に払わせられる上限が変わる
export async function isCertifiedCreator(userId: string): Promise<boolean> {
  const { data, error } = await sb.from("sc_studio_creators").select("certified").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data?.certified);
}

// 管理者：認定開発者を指定する・外す
export async function setCertifiedCreator(userId: string, certified: boolean) {
  const { error } = await sb.from("sc_studio_creators").upsert({ user_id: userId, certified }, { onConflict: "user_id" });
  if (error) throw error;
  return { certified };
}

const chargeHits = new Map<string, number[]>();
function chargeAllowed(me: string): boolean {
  const now = Date.now();
  const recent = (chargeHits.get(me) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= CHARGE_PER_MINUTE) {
    chargeHits.set(me, recent);
    return false;
  }
  recent.push(now);
  chargeHits.set(me, recent);
  return true;
}

// 利用者から、拡張機能の作者へ、ポイントを支払う。作者へは全額が払われる（手数料なし）。
// 同じ requestId で押し直しても二重には払わない（支払いID を idempotency_key にする）。
export async function chargeExtensionPoints(me: string, workId: string, request: { amount: number; title: string; requestId: string }) {
  if (!chargeAllowed(me)) {
    throw new ExtensionError(429, "rate_limited", "支払いの操作が多すぎます。少し待ってからお試しください。");
  }
  const work = await loadExtensionWork(workId);
  if (!(await canOpen(me, work))) {
    throw new ExtensionError(403, "not_owned", "この拡張機能はまだ購入していません。");
  }
  const maxPerCharge = (await isCertifiedCreator(work.creator_id as string)) ? EXT_BRIDGE.chargeMaxCertified : EXT_BRIDGE.chargeMaxDefault;
  if (request.amount > maxPerCharge) {
    throw new ExtensionError(400, "invalid", `1回に支払えるのは ${maxPerCharge}pt までです。`);
  }
  if (!(await isLinked(me))) {
    throw new ExtensionError(403, "not_linked", "ポイントで支払うには、仙人アカウントとの連携が必要です。");
  }
  // 自分の拡張機能への支払いは運営へ返す。運営の設定がなければ、払えない（ポイントだけ消えないように）
  if (work.creator_id === me && !config.operatorUserId) {
    throw new ExtensionError(400, "invalid", "運営の設定がないため、自分の拡張機能へは支払えません。");
  }

  // 同じ requestId の支払いが既にあれば、その今の状態で答える
  const { data: existing, error: readError } = await sb
    .from("sc_extension_charges")
    .select("id, amount, status")
    .eq("user_id", me)
    .eq("work_id", workId)
    .eq("request_id", request.requestId)
    .maybeSingle();
  if (readError) throw readError;
  if (existing) {
    if (Number(existing.amount) !== request.amount) {
      throw new ExtensionError(409, "invalid", "同じ requestId で、金額の違う支払いは作れません。");
    }
    if (existing.status === "done") {
      return { charged: request.amount, replayed: true, points: null as number | null };
    }
    if (existing.status === "failed") {
      throw new ExtensionError(409, "failed", "この支払いは失敗しています。新しい requestId で、もう一度お試しください。");
    }
  }

  let chargeId = existing ? String(existing.id) : "";
  if (!existing) {
    const { data: created, error: insertError } = await sb
      .from("sc_extension_charges")
      .insert({ user_id: me, work_id: workId, request_id: request.requestId, amount: request.amount, title: request.title, status: "reserved" })
      .select("id")
      .single();
    if (insertError) throw insertError;
    chargeId = String(created.id);
  }

  const label = `拡張機能「${work.name}」：${request.title}`.slice(0, 100);
  try {
    const result = await adjustPoints(me, { amount: -request.amount, reason: label, idempotencyKey: `ext-charge-${chargeId}` });
    const { error: doneError } = await sb
      .from("sc_extension_charges")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", chargeId);
    if (doneError) throw doneError;

    // 作者へ全額を支払う。自分の拡張機能なら、運営へ返す（store.ts と同じ扱い）
    const payee = work.creator_id === me ? config.operatorUserId || null : (work.creator_id as string);
    if (payee) {
      await recordSale({ creatorId: payee, workId, chargeId, amount: request.amount }).catch((error) =>
        console.error("[studio] 拡張機能の支払いの売上の記録に失敗:", error)
      );
    }
    return { charged: request.amount, replayed: result.replayed, points: result.points };
  } catch (error) {
    if (error instanceof SenninError && DEFINITE_FAILURE.has(error.code)) {
      // 確実に引かれなかった失敗は、支払いを失敗として閉じる
      await sb
        .from("sc_extension_charges")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", chargeId);
      const status = error.code === "insufficient_points" ? 402 : error.code === "scope" || error.code === "not_linked" ? 403 : error.code === "daily_limit" ? 429 : 409;
      throw new ExtensionError(status, error.code, error.message);
    }
    throw new ExtensionError(503, "unknown", "支払いの結果を確かめられませんでした。同じ requestId で、もう一度お試しください。");
  }
}

// ---- 管理者：配布の上限 ----

export async function setExtensionGrant(
  workId: string,
  args: { maxPoints: number; active: boolean; perUserMinuteMax?: number }
) {
  const work = await loadWork(workId);
  if (!work || work.kind !== "extension") {
    throw new ExtensionError(404, "not_found", "拡張機能が見つかりません。");
  }
  const { data: current, error: readError } = await sb
    .from("sc_extension_grants")
    .select("used_points, per_user_minute_max")
    .eq("work_id", workId)
    .maybeSingle();
  if (readError) throw readError;
  const used = Number(current?.used_points ?? 0);
  if (args.maxPoints < used) {
    throw new ExtensionError(400, "invalid", `すでに ${used}pt 配られているため、上限は ${used}pt より少なくできません。`);
  }
  // 1分あたりの上限は、指定がなければ今の値を残す
  const perUserMinuteMax = args.perUserMinuteMax ?? Number(current?.per_user_minute_max ?? 0);
  // used_points は触らない（すでに配った分を残すため）。行がなければ 0 で作られる
  const { error } = await sb.from("sc_extension_grants").upsert(
    {
      work_id: workId,
      max_points: args.maxPoints,
      active: args.active,
      per_user_minute_max: perUserMinuteMax,
      updated_at: new Date().toISOString()
    },
    { onConflict: "work_id" }
  );
  if (error) throw error;
  return { maxPoints: args.maxPoints, usedPoints: used, active: args.active, perUserMinuteMax };
}

export async function readExtensionGrant(workId: string) {
  const { data, error } = await sb
    .from("sc_extension_grants")
    .select("max_points, used_points, active, per_user_minute_max")
    .eq("work_id", workId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    maxPoints: Number(data.max_points),
    usedPoints: Number(data.used_points),
    active: Boolean(data.active),
    perUserMinuteMax: Number(data.per_user_minute_max ?? 0)
  };
}

// ---- 開発者向けの仕様（senninstudio のドキュメントに表示する。上の定数から作るので、食い違わない） ----

export function extensionSpecMarkdown(): string {
  const { awardMin, awardMaxPerCall, reasonMax, requestIdMin, requestIdMax, timeoutMs } = EXT_BRIDGE;
  return `# senninstudio 拡張機能の仕様（AI・開発者向け）

拡張機能は、HTML・CSS・JavaScript で作るミニアプリです。ソラチャットの画面の中ではなく、隔離された枠（iframe の sandbox）の中で動きます。

## 書けるもの
- HTML：合計 ${EXT_TOTAL_MAX.toLocaleString("en-US")} 文字まで（HTML・CSS・JavaScript の合計）。iframe・embed・meta・base など隔離境界に影響する要素は使えません。
- CSS：@import と外部スタイルシートを利用できます。
- JavaScript：fetch・XMLHttpRequest・WebSocket などの通信 API を利用できます。
- HTTPS の外部ライブラリ・画像・フォントなどを利用できます。
- 拡張機能は sandbox 内で動作し、SoraChat 本体の認証情報や DOM にはアクセスできません。

## ソラチャットの窓口：window.sorachat
枠の中から、ソラチャットに頼みごとをするための窓口です。すべて Promise を返します。

### window.sorachat.getAccount()
利用者の情報を取ります。利用者が許可していないと、エラー（code: "not_consented"）になります。
成功したときの値：
\`\`\`
{
  consented: true,
  sorachat: { id: "ユーザーID", username: "ユーザー名", displayName: "表示名" },
  sennin: { linked: true または false, senninId: "仙人ID または null" },
  grant: { remaining: 残りの配布可能pt } または null
}
\`\`\`

### window.sorachat.requestAccess()
許可されているかを確かめます。許可済みなら { consented: true } を返します。
許可していなければ code: "not_consented" のエラーになります。許可の確認は、拡張機能を開いたときに利用者へ出るので、利用者に許可してもらうには開き直してもらってください。

### window.sorachat.awardPoints(amount, reason, requestId)
利用者（今この拡張機能を開いている本人）に、仙人アカウントのポイントを配ります。
- amount：${awardMin}〜${awardMaxPerCall} の整数（pt）。
- reason：理由（任意・${reasonMax} 文字まで）。仙人アカウント側の履歴に出ます。
- requestId：任意。${requestIdMin}〜${requestIdMax} 文字の英数字・-・_。同じ配布を押し直すときに同じ ID を使うと、二重には配られません。省略すると毎回新しい ID になります。
成功したときの値：\`{ awarded: 配ったpt, replayed: 同じ配布の押し直しか, points: 配布後の残高（取れたとき）}\`

### window.sorachat.charge(amount, title, requestId)
利用者に、ポイントでの支払いを頼みます。ソラチャットの確認画面が出て、利用者が「支払う」を押したときだけ払われます（枠の中から、勝手に払うことはできません）。
- amount：${EXT_BRIDGE.chargeMin} 以上の整数（pt）。1回の上限は、通常 ${EXT_BRIDGE.chargeMaxDefault}pt、認定開発者の作品は ${EXT_BRIDGE.chargeMaxCertified}pt です。
- title：確認画面に出す品名（1〜${EXT_BRIDGE.chargeTitleMax} 文字）。利用者が見て、何にお金を払うのかが分かる名前にしてください。
- requestId：任意。${requestIdMin}〜${requestIdMax} 文字の英数字・-・_。同じ支払いを押し直すときに同じ ID を使うと、二重には払われません。
成功したときの値：\`{ charged: 払ったpt, replayed: 同じ支払いの押し直しか, points: 支払い後の残高（取れたとき） }\`
- 支払いは、作者へ全額が払われます（手数料はありません）。作者が仙人アカウントと未連携のあいだは、売上は保留され、連携したあとにまとめて払われます。
- 利用者が「キャンセル」を押したときは code: "cancelled" になります。
- 確認画面は、枠の外（ソラチャットの画面）に出ます。確認を待つあいだ、枠は止まらず動きます。

## 課金のシステム（ポイントでの支払い）
拡張機能の中で、利用者にポイントで料金を払ってもらう仕組みです。作者はこの仕組みを使って、有料の機能や商品を作れます。

### 支払いの流れ
1. 利用者が、拡張機能の中のボタンなどで購入を選びます。
2. 拡張機能が window.sorachat.charge(金額, 品名, requestId) を呼びます。
3. ソラチャットの画面に、確認画面（品名・金額・いまの残高・支払い後の残高）が出ます。拡張機能の枠の中には出ません。
4. 利用者が「支払う」を押すと、ポイントが利用者から引かれ、作者へ同じ額が払われます。「キャンセル」なら何も払われません。
5. 結果（払った額・残高）が、拡張機能に返ります。

### お金のルール
- 利用者の残高が足りないときは、確認画面の「支払う」が押せず、code: "insufficient_points" になります。
- 支払いは、作者へ全額が払われます（手数料なし）。売上は作者のポイントとして、仙人アカウントに入ります。
- 作者が仙人アカウントと未連携のあいだは、売上は保留されます。連携すると、保留分をまとめて払います。
- 利用者が仙人アカウントと未連携のときは、支払えません（code: "not_linked"）。
- 同じ requestId で押し直しても、二重には引かれません。結果が分からなかったとき（code: "unknown"）は、同じ requestId で頼み直してください。
- 払った支払いは、利用者の仙人アカウントの履歴に、品名つきで残ります。

### 上限
- 1回の支払いは、${EXT_BRIDGE.chargeMin} 以上の整数（pt）です。
- 1回の上限は、通常の作者は ${EXT_BRIDGE.chargeMaxDefault}pt まで、認定開発者は ${EXT_BRIDGE.chargeMaxCertified}pt までです。認定は運営が決めます。作者が自分で上げることはできません。
- 1分間に頼める支払いの回数にも上限があります。連打すると、code: "rate_limited" になります。
- 1回の確認画面が出ているあいだは、次の支払いを頼めません（code: "busy"）。

### 作り方の例（有料の機能）
\`\`\`html
<button id="buy">ヒントを買う（50pt）</button>
<p id="msg"></p>
<script>
document.getElementById("buy").onclick = async () => {
  try {
    const res = await window.sorachat.charge(50, "ヒント", "hint-" + Date.now());
    document.getElementById("msg").textContent = "ヒントを開きます（残り " + res.points + "pt）";
  } catch (e) {
    if (e.code === "cancelled") return;
    document.getElementById("msg").textContent = "買えませんでした：" + e.message;
  }
};
</script>
\`\`\`

### 作者が守ること
- 品名（title）には、実際に買うものを正しく書いてください。違う内容で払わせることは禁止です。
- 払わせる前に、何が手に入るかを枠の中で分かるように見せてください。
- 支払いの確認画面の代わりになる画面（偽の支払い画面、残高の偽装など）を、枠の中に作ってはいけません。確認画面は、ソラチャットが出すものだけです。
- 支払いを頼んだあとは、結果（成功・キャンセル・失敗）に合わせて表示を変えてください。

### 拡張機能内課金の実装手順
1. 買うボタンを作ります。押す前に、何が手に入るか・いくら払うかを枠の中に表示してください（確認画面に出るのと同じ金額にします）。
2. ボタンが押されたら、requestId を1回だけ作ります（例：「buy-」+ 時刻 + ランダムな文字）。同じ購入を押し直すときは、同じ requestId を使います。
3. window.sorachat.charge(金額, 品名, requestId) を呼びます。確認画面が出ているあいだは、ボタンを押せないようにしてください。
4. 結果で分けます。成功なら、買ったものを使えるようにします。cancelled なら何もしません。unknown か timeout なら、「同じ購入を押し直せば、二重には払われません」と伝えます。それ以外のエラーは、理由を表示して、次の購入では新しい requestId を作ります。
5. 結果を受けたら、ボタンを押せる状態に戻します。

### 拡張機能内課金の注意
- 枠は sandbox で動くため、localStorage・sessionStorage・Cookie は使えません。次に開いたときに「買ったかどうか」を覚える仕組みは、ソラチャットにはありません。何度でも買える商品（消費型）として作るか、買った記録を作者側で持つ場合は、その記録の正しさをソラチャットは保証しない、と考えてください。
- timeout のあとも、確認画面が開いたままのことがあります。その場合、利用者が「支払う」を押すと払われますが、結果は拡張機能に返りません。同じ requestId で頼み直すと、利用者にはもう一度確認画面が出ますが、払われるのは一度だけです（replayed が true で返ります）。
- 支払いの金額・品名は、確認画面に出る値がそのまま使われます。枠の中で値を変えて払わせることはできません。

### 拡張機能内課金の完全な例（購入の結果を分けて扱う）
\`\`\`html
<button id="buy" type="button">ヒントを買う（50pt）</button>
<p id="msg"></p>
<script>
var buy = document.getElementById("buy");
var msg = document.getElementById("msg");
var pendingId = ""; // 同じ購入を押し直すときに使う requestId

function say(text) { msg.textContent = text; }

function explain(e) {
  switch (e.code) {
    case "insufficient_points": return "ポイントが足りません。";
    case "not_linked": return "ポイントで買うには、仙人アカウントとの連携が必要です。";
    case "busy": return "ほかの支払いの確認が出ています。終わってから、もう一度押してください。";
    case "rate_limited": return "押しすぎです。少し待ってから、もう一度押してください。";
    case "not_consented": return "拡張機能を開き直して、アカウント情報の許可をしてください。";
    default: return "買えませんでした：" + e.message;
  }
}

function openHint() {
  say("ヒントを開きます。");
  // ここで、買ったヒントを画面に出す（作者の処理）
}

buy.onclick = async function () {
  buy.disabled = true;
  if (!pendingId) pendingId = "hint-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  say("確認画面を開いています…");
  try {
    await window.sorachat.charge(50, "ヒント（1回分）", pendingId);
    pendingId = "";
    openHint();
  } catch (e) {
    if (e.code === "unknown" || e.code === "timeout") {
      // 結果が分からない。同じ requestId で押し直すと、二重には払われない
      say("結果を確かめられませんでした。もう一度押してください。二重には払われません。");
    } else {
      pendingId = "";
      say(e.code === "cancelled" ? "" : explain(e));
    }
  } finally {
    buy.disabled = false;
  }
};
</script>
\`\`\`

## データの保存（window.sorachat.storage・無料）

拡張機能の中のデータ（進み具合・設定・記録など）を、仙人アカウントにひもづけて保存できます。保存先は「仙人アカウント × この拡張機能」なので、ソラチャットのアカウントを作り直しても、同じ仙人アカウントなら同じデータを読めます。料金はかかりません。

- 使うには、この拡張機能を買っていて、情報の許可をしていて、仙人アカウントと連携している必要があります。連携していなければ、code が "not_linked" のエラーになります。
- キーは英数字と _ . : - だけで、${STORAGE.keyMax} 文字までです。
- 値は JSON にできるものだけで、1つ ${STORAGE.valueMaxBytes / 1024}KB までです。1人・1つの拡張機能で ${STORAGE.keysMax} 件までです。
- 1分に ${STORAGE.writesPerMinute} 回まで書けます（超えると code が "rate_limited" になります）。

### window.sorachat.storage.get(key)
値を返します（保存されていなければ null）。

### window.sorachat.storage.set(key, value)
値を保存します（同じキーがあれば上書き）。

### window.sorachat.storage.remove(key)
キーを消します。

### window.sorachat.storage.keys()
保存されているキーの一覧を返します。

### 例
    <script>
      window.sorachat.storage.get("score").then(function (score) {
        document.body.textContent = "ベスト：" + (score === null ? "まだありません" : score);
      }).catch(function (e) { document.body.textContent = e.message; });
    </script>

## オンライン対戦（window.sorachat.battle）

2人以上で遊ぶ対戦を、ソラチャットが相手探し・部屋・中継を受け持ちます。枠の中のコードに渡るのは、相手の席の番号（seat）と表示名だけです。相手のIDなどは渡りません。

- 対戦は、サブスク（1週間 ${BATTLE.subscriptionPoints}pt）に入っている人だけが使えます。自動更新をオンにしていると、期限が切れて対戦を始めるときに1回分が引かれます。入っていない人には、ソラチャットの画面がサブスクの案内を出します。
- 対戦を始める人（と相手）は、この拡張機能を買っていて、情報の許可をしている必要があります。
- 対戦の結果の判定・ポイントの扱いは、作者が書きます（ソラチャットは勝敗を判定しません）。対戦中のデータは、同じ部屋の人へ中継されるだけです。

### window.sorachat.battle.subscription()
サブスクの今の状態を返します。{ subscribed, expiresAt, autoRenew, linked, price, days }

### window.sorachat.battle.findMatch(size)
ランダムに相手を探します。size は 2〜4（省略時は 2）。人数がそろうと、部屋ができてから答えます。
答えの形：{ roomId, size, seat, players: [{ seat, name }] }
利用者が探すのをやめた場合は、code が "cancelled" のエラーになります。

### window.sorachat.battle.inviteFriends()
利用者の友だちを選ぶ画面を出します（1〜3人）。招待された人が承諾し、利用者が「開始」を押すと対戦が始まります。
答えの形は findMatch と同じです。

### window.sorachat.battle.send(payload)
同じ部屋の相手へ、データを送ります。JSON にできる値で、${BATTLE.messageMaxBytes} 文字までです。
送りすぎると、1秒に ${BATTLE.messagesPerSecond} 回までになります。

### window.sorachat.battle.leave()
部屋から出ます。

### window.sorachat.battle.onEvent(function (event) { ... })
相手の動きや、部屋の知らせを受け取ります。最初に一度だけ登録してください（対戦の前に登録しておくと、相手の最初の一手も受け取れます）。
event.type は次のどれかです。
- "message"：相手からのデータ（from は相手の席の番号、payload は送られた値）
- "joined"：招待した人が承諾した（name）
- "declined"：招待した人が断った（name）
- "started"：対戦が始まった（players）。招待を受けた人は、ここで始まりを知ります
- "waiting"：招待を承諾して、主催者が始めるのを待っている（roomId）
- "unselected"：招待した部屋が始まり、この人は承諾していなかったので加わらなかった
- "left"：相手が抜けた（leftSeat）。残りが2人未満になると、次は "closed" になります
- "closed"：部屋が閉じた（reason は "opponent_left" / "host_left" / "timeout"）
- "error"：送信などの失敗（error）

### 作り方の例（ランダムの2人対戦）
    <button id="go">対戦する</button>
    <script>
      var me = null;
      // 先に登録する（相手の一手を取りこぼさないため）
      window.sorachat.battle.onEvent(function (ev) {
        if (ev.type === "message") console.log("相手の手", ev.payload);
        if (ev.type === "closed") alert("対戦が終わりました");
      });
      document.getElementById("go").onclick = async function () {
        try {
          me = await window.sorachat.battle.findMatch(2);
          await window.sorachat.battle.send({ hello: me.seat });
        } catch (e) {
          alert(e.message);
        }
      };
    </script>

### 対戦のエラーの code
- not_subscribed：サブスクに入っていません（ソラチャットの画面で案内を出します）
- busy：すでに対戦の中か、相手を探しています
- cancelled：利用者が取り消しました
- not_consented：アカウント情報の許可がありません
- not_owned：この拡張機能を買っていません
- invitee_unavailable：招待した友だちが、今は対戦を始められません（オンラインでない・サブスク切れなど）

## 作り方：オンラインゲーム（手順と完全な例）

ソラチャットは、相手探し・招待・部屋・中継を受け持ちます。ゲームのルール・手の判定・勝敗は、作者のコードが書きます。サーバーは、対戦中のデータを中身を読まずに相手へ渡すだけです。

### 手順
1. 最初に window.sorachat.battle.onEvent を登録する（相手の一手を取りこぼさないため）。
2. 対戦を始める。ランダムなら findMatch(人数)、友だちなら inviteFriends() を呼ぶ。どちらも、部屋ができたら答えを返す（seat と players が入る）。
3. 自分の手などを send で送る。相手からの手は onEvent で "message" として届く。
4. 両方の手がそろったら、枠の中で勝敗を判定して画面に出す。
5. 終わったら leave で部屋を出る。"closed" が届いたら、画面を終わりの表示に切り替える。

### 注意
- 相手が切断したときは "left" や "closed" が届きます。待ち続けないよう、必ず処理してください。
- 判定を作者のコードだけで行うため、送られてきた値が正しいとは限りません。大事な判定は、受け取る側で値の形を確かめてください。
- ポイントを配る・支払うなどは、勝った人だけが一度だけ行うように作ってください（同じ requestId で押し直す）。
- 対戦中は、同じ部屋の相手以外へデータは届きません。

### 完全な例（じゃんけんの2人対戦）
    <div id="status">対戦相手を探してください</div>
    <button id="random">ランダムで対戦</button>
    <button id="friend">友だちと対戦</button>
    <div id="hands" hidden>
      <button data-hand="rock">グー</button>
      <button data-hand="scissors">チョキ</button>
      <button data-hand="paper">パー</button>
    </div>
    <script>
      var sb = window.sorachat;
      var inRoom = false;
      var myHand = null;
      var theirHand = null;
      var beats = { rock: "scissors", scissors: "paper", paper: "rock" };
      var names = { rock: "グー", scissors: "チョキ", paper: "パー" };

      function show(text) { document.getElementById("status").textContent = text; }

      // 最初に登録する（相手の手を取りこぼさないように）
      sb.battle.onEvent(function (ev) {
        if (ev.type === "message" && ev.payload && ev.payload.kind === "hand") {
          theirHand = ev.payload.hand;
          judge();
        } else if (ev.type === "started") {
          startRound("対戦が始まりました");
        } else if (ev.type === "left") {
          show("相手が抜けました");
        } else if (ev.type === "closed") {
          inRoom = false;
          document.getElementById("hands").hidden = true;
          show("対戦が終わりました（" + ev.reason + "）");
        }
      });

      function startRound(text) {
        inRoom = true;
        myHand = null;
        theirHand = null;
        document.getElementById("hands").hidden = false;
        show(text + "。手を選んでください");
      }

      function judge() {
        if (!myHand || !theirHand) return;
        var result = myHand === theirHand ? "あいこ" : beats[myHand] === theirHand ? "あなたの勝ち" : "あなたの負け";
        show(result + "（あなた：" + names[myHand] + " / 相手：" + names[theirHand] + "）");
        myHand = null;
        theirHand = null;
      }

      function startMatch(run) {
        show("探しています…");
        run().then(function (room) {
          // room.seat と room.players が入る。ここでは開始の表示だけにする
          startRound("対戦が始まりました（あなたは " + (room.seat + 1) + " 番）");
        }).catch(function (e) {
          show(e.message);
        });
      }

      document.getElementById("random").onclick = function () {
        startMatch(function () { return sb.battle.findMatch(2); });
      };
      document.getElementById("friend").onclick = function () {
        startMatch(function () { return sb.battle.inviteFriends(); });
      };

      document.querySelectorAll("[data-hand]").forEach(function (button) {
        button.onclick = function () {
          if (!inRoom || myHand) return;
          myHand = button.getAttribute("data-hand");
          sb.battle.send({ kind: "hand", hand: myHand }).catch(function (e) { show(e.message); });
          show("手を送りました。相手を待っています");
          judge();
        };
      });
    </script>

### 友だち対戦の流れ
- inviteFriends() を呼ぶと、ソラチャットの画面が友だちを選ぶ画面を出します（1〜3人）。
- 招待された人には、ソラチャットの全画面に招待が出ます。承諾した人には、枠の中で "waiting" が届きます。
- 招待した人が「開始」を押すと、承諾した全員に "started" が届き、inviteFriends() も答えを返します。承諾しなかった人は "unselected" を受け取ります。
- 上の例の "started" の扱いは、招待を受けた側でも同じです。

## 作り方：データ保存（手順と完全な例）

拡張機能の中のデータを、仙人アカウントにひもづけて保存できます（無料）。保存先は「仙人アカウント × この拡張機能」です。使うには、この拡張機能を買っていて、情報の許可をしていて、仙人アカウントと連携している必要があります。

### 手順
1. 起動したときに、get で前の値を読む（なければ null）。
2. 変わったら set で保存する。消すときは remove、一覧は keys。
3. エラーは、Promise の catch で受けて画面に出す。e.code で理由を判断できる（not_linked・not_consented・rate_limited・full・invalid など）。

### 注意
- 同じキーを同時に書くと、後から書いた値が残ります。1つの値にまとめて保存し、書く順番は作者のコードで整えてください。
- 1分に書ける回数に上限があります。ボタンを押すたびに保存するのではなく、区切りのよいタイミングでまとめて保存してください。
- 連携していない人には、保存できないことを画面で伝えてください（code が not_linked のとき）。

### 完全な例（勝ち数を保存する）
    <p id="wins">読み込み中…</p>
    <button id="win">勝った（+1）</button>
    <p id="error" hidden></p>
    <script>
      var sb = window.sorachat;
      var wins = 0;

      function show() {
        document.getElementById("wins").textContent = "勝ち数：" + wins;
      }
      function fail(e) {
        var box = document.getElementById("error");
        box.hidden = false;
        box.textContent = e.code === "not_linked"
          ? "保存するには、仙人アカウントとの連携が必要です。"
          : e.message;
      }

      // 起動したときに、前の値を読む（保存されていなければ null）
      sb.storage.get("wins").then(function (value) {
        wins = typeof value === "number" ? value : 0;
        show();
      }).catch(fail);

      document.getElementById("win").onclick = function () {
        wins += 1;
        show();
        sb.storage.set("wins", wins).catch(fail);
      };
    </script>

### 値のまとめ方
- 1つのキーに、オブジェクトでまとめて保存できます（例：{ best: 120, plays: 8 }）。
- 値は JSON にできるものだけです。関数・循環する値は保存できません。

## 配布のルール（必ず守られます）
1. 配れるのは、この拡張機能を開いて、アカウント情報の許可をした本人だけです。他の人には配れません。
2. 配れる量は、運営（管理者）が拡張機能ごとに決めた上限の中だけです。上限を超えると code: "exhausted" になり、残りの量が返ります。作者が上限を変えることはできません。
3. 利用者が仙人アカウントと連携していないと、配れません（code: "not_linked"）。
4. 1回に配れるのは ${awardMin}〜${awardMaxPerCall}pt です。1分に配布を頼める回数にも上限があります。さらに、1人が1分間に受け取れるポイントにも上限があります（運営が拡張機能ごとに決めます。0 は制限なし）。超えると code: "minute_limit" になり、error.data.remaining で、その分の残りが分かります。
5. 配布は仙人アカウントの履歴に残ります（理由つき）。
6. 上限を決めていない拡張機能は、配布できません（code: "inactive"）。運営に配布の許可を頼んでください。

## エラーの code
- not_consented：利用者が許可していない（拡張機能は許可がないと開けないので、通常は起きません）
- not_linked：仙人アカウントと未連携
- exhausted：上限に達した（error.data.remaining で残りのptが分かる）
- cancelled：利用者が支払いを取り消した
- insufficient_points：ポイントが足りない
- busy：ほかの支払いの確認が出ている（終わってから、もう一度頼んでください）
- inactive：配布の許可がない
- rate_limited：頼みすぎ。少し待つ
- minute_limit：1人が1分間に受け取れるポイントの上限に達した（error.data.remaining で残りが分かる）
- failed：同じ requestId の配布・支払いが失敗している。新しい requestId で頼み直す
- invalid：依頼の中身が正しくない（金額・品名・requestId の形など）
- unknown：結果を確かめられなかった。同じ requestId で押し直す
- timeout：ソラチャットから応答がない（${Math.round(timeoutMs / 1000)} 秒）

## 作り方の例
\`\`\`html
<button id="play">遊ぶ</button>
<p id="msg"></p>
<script>
document.getElementById("play").onclick = async () => {
  try {
    const me = await window.sorachat.getAccount();  // 許可されていれば、利用者の情報が取れる
    await window.sorachat.awardPoints(10, "クリア", "clear-" + me.sorachat.id + "-1");
    document.getElementById("msg").textContent = "10pt もらいました";
  } catch (e) {
    document.getElementById("msg").textContent = "できませんでした：" + e.message;
  }
};
</script>
\`\`\`

## 注意
- 試し表示（編集画面の「試し表示」）では、ソラチャットの窓口は応答しません。配布は、購入した拡張機能を本番で開いて確かめてください。
- 利用者は、いつでも許可を取り消せます。取り消すと、アカウント情報や配布は止まります。
- 配布の上限を決めるのは運営です。作者は、配れる量を自分で増やせません。
- 支払いの確認画面は、利用者が「支払う」を押したときだけ払われます。拡張機能の中から、確認なしに払うことはできません。
- 課金の上限（1回の金額）も、作者が自分で増やすことはできません。
`;
}
