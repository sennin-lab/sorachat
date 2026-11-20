import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { banOf, cookieBase, type BanInfo } from "./auth.js";
import { disconnectUser } from "./hub.js";
import { isAllowedImage, readImage, removeImage, saveImage, upload } from "./media.js";
import { sb } from "./supabase.js";
import { decryptText, encryptText } from "./crypto.js";
import { broadcastList, broadcastToConversation, removeImageIfUnused, UUID } from "./messages.js";
import { sendAnnouncement, TEAM_ID } from "./team.js";
import { getMaintenanceSettings, updateMaintenanceSettings } from "./maintenance.js";
import { addIpBan, manualIp, removeIpBan } from "./ipBans.js";

// 管理者パネル専用のAPI。一般の画面からはこの入口を使わない（管理者パスワードでだけ入れる）
export const admin = Router();

export const ADMIN_COOKIE = "sc_admin";
const ADMIN_MS = 12 * 60 * 60 * 1000;

// ---- 管理者の証明書（署名つきのCookie。サーバー側に保存しない）----
const signKey = () => `${config.supabaseJwtSecret}:${config.adminPassword}`;
const sign = (expiresAt: number) => crypto.createHmac("sha256", signKey()).update(`admin:${expiresAt}`).digest("base64url");

function makeToken() {
  const expiresAt = Date.now() + ADMIN_MS;
  return `${expiresAt}.${sign(expiresAt)}`;
}

function validToken(token: unknown) {
  if (typeof token !== "string") return false;
  const [expRaw, signature] = token.split(".");
  const expiresAt = Number(expRaw);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = Buffer.from(sign(expiresAt));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const sha = (value: string) => crypto.createHash("sha256").update(value).digest();
const passwordMatches = (input: string) => crypto.timingSafeEqual(sha(input), sha(config.adminPassword));

// 管理者ログインの試行回数制限（15分に10回まで）
const attempts = new Map<string, { count: number; resetAt: number }>();
function loginLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > 10) {
    res.status(429).json({ error: "試行回数が多すぎます。しばらく待ってから再度お試しください。" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!validToken(req.cookies?.[ADMIN_COOKIE])) {
    res.status(401).json({ error: "管理者としてログインしてください。" });
    return;
  }
  next();
}

const idParam = (req: Request, res: Response): string | null => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ error: "見つかりません。" });
    return null;
  }
  return id;
};

// ---- ログイン・ログアウト（管理者ログインは認証の前に置く）----
admin.post("/admin/login", loginLimit, (req, res) => {
  if (!config.adminPassword) {
    res.status(503).json({ error: "管理者ログインは設定されていません。ADMIN_PASSWORD を設定してください。" });
    return;
  }
  const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success || !passwordMatches(parsed.data.password)) {
    res.status(401).json({ error: "パスワードが違います。" });
    return;
  }
  res.cookie(ADMIN_COOKIE, makeToken(), { ...cookieBase, sameSite: "strict", maxAge: ADMIN_MS });
  res.json({ ok: true });
});

admin.post("/admin/logout", (_req, res) => {
  res.clearCookie(ADMIN_COOKIE, cookieBase);
  res.json({ ok: true });
});

// ここから下は管理者だけ
admin.use("/admin", requireAdmin);

admin.get("/admin/session", (_req, res) => {
  res.json({ ok: true });
});

// ---- メンテナンスモード ----
admin.get("/admin/maintenance", (_req, res) => {
  res.set("Cache-Control", "no-store").json(getMaintenanceSettings());
});

admin.put("/admin/maintenance", async (req, res) => {
  const parsed = z.object({ enabled: z.boolean(), message: z.string().trim().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "設定内容が正しくありません。" }); return; }
  try {
    const settings = await updateMaintenanceSettings(parsed.data.enabled, parsed.data.message ?? getMaintenanceSettings().message);
    res.set("Cache-Control", "no-store").json({ ok: true, ...settings });
  } catch (error) {
    console.error("メンテナンス設定の保存に失敗しました", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "設定を保存できませんでした。" });
  }
});

// ---- ユーザー ----
const USER_COLUMNS = "id, username, display_name, bio, contact, profile_url, avatar_path, sennin_id, cover_theme, created_at, banned_at, banned_until, ban_reason";

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  contact: string | null;
  profile_url: string | null;
  avatar_path: string | null;
  sennin_id: string | null;
  cover_theme: string | null;
  created_at: string;
  banned_at: string | null;
  banned_until: string | null;
  ban_reason: string | null;
};

// 利用停止は「期限が過ぎていないもの」だけ有効。ban が null なら利用中
const userSummary = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  hasAvatar: Boolean(u.avatar_path),
  sennin: Boolean(u.sennin_id),
  createdAt: u.created_at,
  ban: banOf(u) as BanInfo | null
});

admin.get("/admin/users", async (req, res) => {
  // 検索語の記号は取り除く（検索条件の書式を壊さないため）
  const q = String(req.query.q ?? "").trim().replace(/[^\p{L}\p{N}_ -]/gu, "").slice(0, 40);
  let query = sb.from("sc_users").select(USER_COLUMNS).order("created_at", { ascending: false }).limit(200);
  if (q) query = query.or(`username.ilike.%${q}%,display_name.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) throw error;
  res.json(((data ?? []) as UserRow[]).map(userSummary));
});

admin.get("/admin/users/:id", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { data: user, error } = await sb
    .from("sc_users")
    .select(`${USER_COLUMNS}, signup_ip, last_ip, invite_code`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!user) {
    res.status(404).json({ error: "ユーザーが見つかりません。" });
    return;
  }
  const { data: friendRows, error: friendError } = await sb.from("sc_friends").select("friend_id").eq("user_id", id);
  if (friendError) throw friendError;
  const friendIds = (friendRows ?? []).map((row: { friend_id: string }) => row.friend_id);
  let friends: UserRow[] = [];
  if (friendIds.length) {
    const { data, error: usersError } = await sb.from("sc_users").select(USER_COLUMNS).in("id", friendIds);
    if (usersError) throw usersError;
    friends = (data ?? []) as UserRow[];
  }
  const { data: memberRows, error: memberError } = await sb.from("sc_members").select("conversation_id").eq("user_id", id);
  if (memberError) throw memberError;
  const conversations = await loadSummaries((memberRows ?? []).map((row: { conversation_id: string }) => row.conversation_id));
  const { count: invitedCount } = await sb
    .from("sc_referrals")
    .select("id", { count: "exact", head: true })
    .eq("inviter_id", id);
  res.json({
    ...userSummary(user as UserRow),
    bio: user.bio,
    contact: user.contact ?? "",
    profileUrl: user.profile_url ?? "",
    coverTheme: user.cover_theme ?? "green",
    // IP（取得できていないときは null。管理者が手入力で BAN することもできる）
    signupIp: (user.signup_ip as string | null) ?? null,
    lastIp: (user.last_ip as string | null) ?? null,
    inviteCode: (user.invite_code as string | null) ?? null,
    invitedCount: invitedCount ?? 0,
    friends: friends.map(userSummary),
    conversations
  });
});

admin.get("/admin/users/:id/avatar", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { data } = await sb.from("sc_users").select("avatar_path").eq("id", id).maybeSingle();
  const image = data?.avatar_path ? await readImage(data.avatar_path) : null;
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader("content-type", image.type);
  res.setHeader("cache-control", "private, no-cache");
  res.send(image.buffer);
});

// 利用停止の期間。permanent なら永久、そうでなければ amount × unit のあいだ
const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
const MAX_BAN_MS = 10 * 365 * 86_400_000;
const banSchema = z.object({
  permanent: z.boolean(),
  amount: z.number().int().min(1).max(100_000).optional(),
  unit: z.enum(["minutes", "hours", "days"]).optional(),
  reason: z.string().trim().max(200).optional()
});

// BAN: 期間つき・永久から選ぶ。セッションは残し、利用者の画面に「利用停止」と期限を出す（ログアウトはできない）
admin.post("/admin/users/:id/ban", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success || (!parsed.data.permanent && (!parsed.data.amount || !parsed.data.unit))) {
    res.status(400).json({ error: "利用停止の期間を入力してください。" });
    return;
  }
  const now = Date.now();
  let bannedUntil: string | null = null;
  if (!parsed.data.permanent) {
    const ms = parsed.data.amount! * UNIT_MS[parsed.data.unit!];
    if (ms > MAX_BAN_MS) {
      res.status(400).json({ error: "期間は10年までにしてください。" });
      return;
    }
    bannedUntil = new Date(now + ms).toISOString();
  }
  const bannedAt = new Date(now).toISOString();
  const banReason = parsed.data.reason ? parsed.data.reason : null;
  const { data, error } = await sb
    .from("sc_users")
    .update({ banned_at: bannedAt, banned_until: bannedUntil, ban_reason: banReason })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "ユーザーが見つかりません。" });
    return;
  }
  // 開いている接続は閉じる（利用者の画面が利用停止の表示に切り替わる）
  disconnectUser(id);
  res.json({ ok: true, ban: banOf({ banned_at: bannedAt, banned_until: bannedUntil, ban_reason: banReason }) });
});

admin.post("/admin/users/:id/unban", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { error } = await sb.from("sc_users").update({ banned_at: null, banned_until: null, ban_reason: null }).eq("id", id);
  if (error) throw error;
  res.json({ ok: true });
});

// ---- IP BAN ----
const ipSchema = z.object({ ip: z.string().trim().max(64), reason: z.string().trim().max(200).optional() });

admin.get("/admin/ip-bans", async (_req, res) => {
  const { data, error } = await sb.from("sc_ip_bans").select("ip, reason, created_at").order("created_at", { ascending: false });
  if (error) throw error;
  res.json(
    (data ?? []).map((row: { ip: string; reason: string | null; created_at: string }) => ({
      ip: row.ip,
      reason: row.reason,
      createdAt: row.created_at
    }))
  );
});

// IP を手入力して BAN する（IP が取得できなかった人や、既知の IP を止めるとき）
admin.post("/admin/ip-bans", async (req, res) => {
  const parsed = ipSchema.safeParse(req.body);
  const ip = parsed.success ? manualIp(parsed.data.ip) : null;
  if (!ip) {
    res.status(400).json({ error: "IPアドレスの形式が正しくありません（例: 203.0.113.10 / 2001:db8::1）。" });
    return;
  }
  await addIpBan(ip, parsed.success && parsed.data.reason ? parsed.data.reason : null);
  res.json({ ok: true, ip });
});

admin.delete("/admin/ip-bans/:ip", async (req, res) => {
  const ip = manualIp(req.params.ip);
  if (!ip) {
    res.status(400).json({ error: "IPアドレスの形式が正しくありません。" });
    return;
  }
  await removeIpBan(ip);
  res.json({ ok: true });
});

// ユーザーの IP を BAN する。source: last（最後のログイン）/ signup（登録時）/ manual（手入力）
const userIpSchema = z.object({
  source: z.enum(["last", "signup", "manual"]),
  ip: z.string().trim().max(64).optional(),
  reason: z.string().trim().max(200).optional()
});

admin.post("/admin/users/:id/ip-ban", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = userIpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "IPの指定が正しくありません。" });
    return;
  }
  let ip: string | null = null;
  if (parsed.data.source === "manual") {
    ip = manualIp(parsed.data.ip);
    if (!ip) {
      res.status(400).json({ error: "IPアドレスの形式が正しくありません（例: 203.0.113.10 / 2001:db8::1）。" });
      return;
    }
  } else {
    const { data, error } = await sb.from("sc_users").select("signup_ip, last_ip").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "ユーザーが見つかりません。" });
      return;
    }
    ip = manualIp(parsed.data.source === "last" ? data.last_ip : data.signup_ip);
  }
  if (!ip) {
    // 取得できていないときは、管理者に IP の手入力を求める（画面のモーダルで source: "manual" を送る）
    res.status(422).json({ code: "ip_unknown", error: "このユーザーのIPアドレスは記録されていません。IPアドレスを手入力してください。" });
    return;
  }
  await addIpBan(ip, parsed.data.reason ? parsed.data.reason : null);
  res.json({ ok: true, ip });
});

// アイコン画像の設定・削除（管理者が不適切な画像を外したり、差し替えたりできる）
admin.post("/admin/users/:id/avatar", upload.single("file"), async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  if (!isAllowedImage(req.file)) {
    res.status(415).json({ error: "JPEG・PNG・WebP・GIF の画像を選んでください。" });
    return;
  }
  const { data: user, error: readError } = await sb.from("sc_users").select("avatar_path").eq("id", id).maybeSingle();
  if (readError) throw readError;
  if (!user) {
    res.status(404).json({ error: "ユーザーが見つかりません。" });
    return;
  }
  const path = await saveImage(req.file!, `avatars/${id}`);
  const { error } = await sb.from("sc_users").update({ avatar_path: path }).eq("id", id);
  if (error) throw error;
  await removeImage(user.avatar_path ?? null);
  res.json({ ok: true, hasAvatar: true });
});

admin.delete("/admin/users/:id/avatar", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { data: user, error: readError } = await sb.from("sc_users").select("avatar_path").eq("id", id).maybeSingle();
  if (readError) throw readError;
  if (!user) {
    res.status(404).json({ error: "ユーザーが見つかりません。" });
    return;
  }
  const { error } = await sb.from("sc_users").update({ avatar_path: null }).eq("id", id);
  if (error) throw error;
  await removeImage(user.avatar_path ?? null);
  res.json({ ok: true, hasAvatar: false });
});

// 管理者は、誰とでも友だちにできる（相手の承認は不要。相互に1行ずつ保存する）
admin.post("/admin/users/:id/friends", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,20}$/) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ユーザー名を入力してください。" });
    return;
  }
  const { data: other, error } = await sb.from("sc_users").select(USER_COLUMNS).eq("username", parsed.data.username).maybeSingle();
  if (error) throw error;
  if (!other) {
    res.status(404).json({ error: "そのユーザーは見つかりません。" });
    return;
  }
  if (other.id === id) {
    res.status(400).json({ error: "同じユーザー同士は友だちにできません。" });
    return;
  }
  const { error: upsertError } = await sb.from("sc_friends").upsert(
    [
      { user_id: id, friend_id: other.id },
      { user_id: other.id, friend_id: id }
    ],
    { onConflict: "user_id,friend_id", ignoreDuplicates: true }
  );
  if (upsertError) throw upsertError;
  res.status(201).json(userSummary(other as UserRow));
});

// ---- パスワードの再設定（今のパスワードは保存されていない＝見られない。新しく設定する）----
const passwordSchema = z.object({
  password: z.string().min(8, "パスワードは8文字以上にしてください。").max(72, "パスワードは72文字以内にしてください。")
});

admin.post("/admin/users/:id/password", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { data, error } = await sb.rpc("sc_set_password", { p_user_id: id, p_password: parsed.data.password });
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "ユーザーが見つかりません。" });
    return;
  }
  // 今のログインは全て切る（新しいパスワードで入り直してもらう）
  const { error: sessionError } = await sb.from("sc_sessions").delete().eq("user_id", id);
  if (sessionError) throw sessionError;
  disconnectUser(id);
  res.json({ ok: true });
});

// ---- メッセージの削除（取り消しの表示も残さず、トークから消す。相手の画面からも消える）----
const PREVIEW_LABEL: Record<string, string> = { image: "画像", file: "ファイル", contact: "連絡先", stamp: "スタンプ", poll: "投票", game: "ミニゲーム" };

async function refreshLastPreview(conversationId: string, deletedAt: string) {
  // 削除したのが一番新しいメッセージだった場合、一覧に出す最後の文を残っているものに直す
  const { data: latest, error } = await sb
    .from("sc_messages")
    .select("kind, body, sender_id, created_at")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!latest) return;
  const text = latest.kind === "text" || latest.kind === "system" ? decryptText(latest.body) ?? "" : PREVIEW_LABEL[latest.kind] ?? "";
  await sb
    .from("sc_conversations")
    .update({ last_message_at: latest.created_at, last_sender_id: latest.sender_id, last_preview: encryptText(text.slice(0, 80)) })
    .eq("id", conversationId)
    .eq("last_message_at", deletedAt);
}

admin.delete("/admin/messages/:id", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { data: msg, error: readError } = await sb
    .from("sc_messages")
    .select("id, conversation_id, image_path, file_path, created_at")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw readError;
  if (!msg) {
    res.status(404).json({ error: "メッセージが見つかりません。" });
    return;
  }
  // 行を消す（リアクション・投票・ミニゲームなどは一緒に消える）
  const { error } = await sb.from("sc_messages").delete().eq("id", id);
  if (error) throw error;
  if (msg.image_path) await removeImageIfUnused(msg.image_path);
  if (msg.file_path) await removeImageIfUnused(msg.file_path);
  await refreshLastPreview(msg.conversation_id as string, msg.created_at as string);
  await broadcastToConversation(msg.conversation_id as string, { type: "message_removed", conversationId: msg.conversation_id, id });
  await broadcastList(msg.conversation_id as string);
  res.json({ ok: true });
});

// ---- お知らせ（開発チームから全ユーザーへ）----
const announceSchema = z.object({ body: z.string().trim().min(1).max(1000) });

admin.post("/admin/announcements", async (req, res) => {
  const parsed = announceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "お知らせの本文を入力してください（1000文字まで）。" });
    return;
  }
  const { data, error } = await sb.from("sc_users").select("id").eq("is_bot", false).neq("id", TEAM_ID);
  if (error) throw error;
  const ids = (data ?? []).map((row: { id: string }) => row.id);
  if (!ids.length) {
    res.status(400).json({ error: "送る相手がいません。" });
    return;
  }
  // 人数が多いと時間がかかるので、送信は裏で続ける
  sendAnnouncement(ids, parsed.data.body).catch((err) => console.error("お知らせの送信に失敗しました", err));
  res.json({ ok: true, queued: ids.length });
});

// ---- チャット（全員分を閲覧できる。送信や編集はできない）----
const CONV_COLUMNS = "id, is_group, title, is_open, last_message_at, last_preview";
type ConvRow = {
  id: string;
  is_group: boolean;
  title: string | null;
  is_open: boolean;
  last_message_at: string;
  last_preview: string | null;
};

async function loadSummaries(ids: string[]) {
  if (!ids.length) return [];
  const { data: convs, error } = await sb
    .from("sc_conversations")
    .select(CONV_COLUMNS)
    .in("id", ids)
    .order("last_message_at", { ascending: false });
  if (error) throw error;
  return summarize((convs ?? []) as ConvRow[]);
}

async function summarize(rows: ConvRow[]) {
  if (!rows.length) return [];
  const { data, error } = await sb
    .from("sc_members")
    .select("conversation_id, role, sc_users(id, username, display_name)")
    .in("conversation_id", rows.map((r) => r.id));
  if (error) throw error;
  const byConv = new Map<string, { id: string; username: string; displayName: string; role: string }[]>();
  for (const row of (data ?? []) as any[]) {
    const list = byConv.get(row.conversation_id) ?? [];
    list.push({ id: row.sc_users.id, username: row.sc_users.username, displayName: row.sc_users.display_name, role: row.role });
    byConv.set(row.conversation_id, list);
  }
  return rows.map((r) => {
    const members = byConv.get(r.id) ?? [];
    return {
      id: r.id,
      isGroup: r.is_group,
      isOpen: r.is_open,
      name: r.is_group ? r.title ?? "グループ" : members.map((m) => m.displayName).join(" と ") || "トーク",
      memberCount: members.length,
      lastMessageAt: r.last_message_at,
      lastPreview: decryptText(r.last_preview),
      members
    };
  });
}

admin.get("/admin/conversations", async (_req, res) => {
  const { data, error } = await sb
    .from("sc_conversations")
    .select(CONV_COLUMNS)
    .order("last_message_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  res.json(await summarize((data ?? []) as ConvRow[]));
});

admin.get("/admin/conversations/:id", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const { data, error } = await sb.from("sc_conversations").select(CONV_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "チャットが見つかりません。" });
    return;
  }
  const [summary] = await summarize([data as ConvRow]);
  res.json(summary);
});

admin.get("/admin/conversations/:id/messages", async (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const beforeRaw = typeof req.query.before === "string" ? req.query.before : null;
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (before && Number.isNaN(before.getTime())) {
    res.status(400).json({ error: "日時の指定が正しくありません。" });
    return;
  }
  let query = sb
    .from("sc_messages")
    .select("id, sender_id, kind, body, created_at, edited_at, deleted_at, forwarded, file_name, file_size, reply_to_id")
    .eq("conversation_id", id);
  if (before) query = query.lt("created_at", before.toISOString());
  const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  const rows = ((data ?? []) as any[]).reverse();
  const senderIds = [...new Set(rows.map((r) => r.sender_id as string))];
  const names = new Map<string, string>();
  if (senderIds.length) {
    const { data: users, error: usersError } = await sb.from("sc_users").select("id, display_name").in("id", senderIds);
    if (usersError) throw usersError;
    for (const u of (users ?? []) as { id: string; display_name: string }[]) names.set(u.id, u.display_name);
  }
  res.json(
    rows.map((r) => {
      const deleted = r.deleted_at !== null;
      return {
        id: r.id,
        senderId: r.sender_id,
        senderName: names.get(r.sender_id) ?? "不明",
        kind: r.kind,
        body: deleted ? null : decryptText(r.body),
        deleted,
        edited: r.edited_at !== null,
        forwarded: r.forwarded,
        replyToId: r.reply_to_id,
        createdAt: r.created_at,
        fileName: r.kind === "file" && !deleted ? r.file_name : null,
        fileSize: r.kind === "file" && !deleted ? r.file_size : null,
        imageUrl: r.kind === "image" && !deleted ? `/api/admin/messages/${r.id}/image` : null,
        fileUrl: r.kind === "file" && !deleted ? `/api/admin/messages/${r.id}/file` : null
      };
    })
  );
});

async function sendMessageFile(req: Request, res: Response, column: "image_path" | "file_path") {
  const id = idParam(req, res);
  if (!id) return;
  const { data } = await sb.from("sc_messages").select(`${column}, file_name`).eq("id", id).maybeSingle();
  const path = data ? (data as Record<string, string | null>)[column] : null;
  const image = path ? await readImage(path) : null;
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader("cache-control", "private, no-cache");
  if (column === "image_path") {
    res.setHeader("content-type", image.type);
  } else {
    const name = (data as { file_name?: string | null } | null)?.file_name ?? "file";
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.send(image.buffer);
}

admin.get("/admin/messages/:id/image", (req, res) => sendMessageFile(req, res, "image_path"));
admin.get("/admin/messages/:id/file", (req, res) => sendMessageFile(req, res, "file_path"));
