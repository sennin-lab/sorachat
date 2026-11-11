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
import { EXT_BRIDGE, EXT_CDN_HOSTS, EXT_TOTAL_MAX } from "./studioRules.js";

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
  const reserved = (data ?? {}) as { result: string; id?: string; status?: string; points?: number; remaining?: number };

  if (reserved.result === "inactive") {
    throw new ExtensionError(403, "inactive", "この拡張機能は、ポイントを配る許可がありません。");
  }
  if (reserved.result === "exhausted") {
    const remaining = Number(reserved.remaining ?? 0);
    throw new ExtensionError(409, "exhausted", `この拡張機能が配れるポイントは、あと ${remaining}pt です。`, remaining);
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

export async function setExtensionGrant(workId: string, args: { maxPoints: number; active: boolean }) {
  const work = await loadWork(workId);
  if (!work || work.kind !== "extension") {
    throw new ExtensionError(404, "not_found", "拡張機能が見つかりません。");
  }
  const { data: current, error: readError } = await sb
    .from("sc_extension_grants")
    .select("used_points")
    .eq("work_id", workId)
    .maybeSingle();
  if (readError) throw readError;
  const used = Number(current?.used_points ?? 0);
  if (args.maxPoints < used) {
    throw new ExtensionError(400, "invalid", `すでに ${used}pt 配られているため、上限は ${used}pt より少なくできません。`);
  }
  // used_points は触らない（すでに配った分を残すため）。行がなければ 0 で作られる
  const { error } = await sb.from("sc_extension_grants").upsert(
    { work_id: workId, max_points: args.maxPoints, active: args.active, updated_at: new Date().toISOString() },
    { onConflict: "work_id" }
  );
  if (error) throw error;
  return { maxPoints: args.maxPoints, usedPoints: used, active: args.active };
}

export async function readExtensionGrant(workId: string) {
  const { data, error } = await sb
    .from("sc_extension_grants")
    .select("max_points, used_points, active")
    .eq("work_id", workId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { maxPoints: Number(data.max_points), usedPoints: Number(data.used_points), active: Boolean(data.active) };
}

// ---- 開発者向けの仕様（senninstudio のドキュメントに表示する。上の定数から作るので、食い違わない） ----

export function extensionSpecMarkdown(): string {
  const { awardMin, awardMaxPerCall, reasonMax, requestIdMin, requestIdMax, timeoutMs } = EXT_BRIDGE;
  return `# senninstudio 拡張機能の仕様（AI・開発者向け）

拡張機能は、HTML・CSS・JavaScript で作るミニアプリです。ソラチャットの画面の中ではなく、隔離された枠（iframe の sandbox）の中で動きます。

## 書けるもの
- HTML：合計 ${EXT_TOTAL_MAX.toLocaleString("en-US")} 文字まで（HTML・CSS・JavaScript の合計）。iframe・embed・meta・base は使えません。
- CSS：@import は使えません。
- JavaScript：fetch・XMLHttpRequest・WebSocket など通信、window.parent / top への手出しは使えません。
- 読み込めるライブラリは、https:// で始まる次の配信元だけです：${EXT_CDN_HOSTS.join("、")}
- 画像は data: で埋め込みます。

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
- 支払いは、作者へ全額が払われます（手数料はありません）。
- 利用者が「キャンセル」を押したときは code: "cancelled" になります。
- 確認画面は、枠の外（ソラチャットの画面）に出ます。確認を待つあいだ、枠は止まらず動きます。

## 配布のルール（必ず守られます）
1. 配れるのは、この拡張機能を開いて、アカウント情報の許可をした本人だけです。他の人には配れません。
2. 配れる量は、運営（管理者）が拡張機能ごとに決めた上限の中だけです。上限を超えると code: "exhausted" になり、残りの量が返ります。作者が上限を変えることはできません。
3. 利用者が仙人アカウントと連携していないと、配れません（code: "not_linked"）。
4. 1回に配れるのは ${awardMin}〜${awardMaxPerCall}pt です。1分に配布を頼める回数にも上限があります。
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
`;
}
