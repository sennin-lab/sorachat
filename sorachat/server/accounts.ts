import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { cookieBase, currentUserId, endSession, randomToken, requireAuth, SESSION_COOKIE, signRealtimeToken, startSession } from "./auth.js";
import { isAllowedImage, readImage, removeImage, saveImage, upload } from "./media.js";
import { sb } from "./supabase.js";

export const accounts = Router();

const hits = new Map<string, { count: number; reset: number }>();
const authLimit = (req: Request, res: Response, next: NextFunction) => {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.reset < now) {
    hits.set(key, { count: 1, reset: now + 60_000 });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > 20) {
    res.status(429).json({ error: "試行回数が多すぎます。少し待ってから再度お試しください。" });
    return;
  }
  next();
};

const UUID = /^[0-9a-f-]{36}$/i;
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, "ユーザー名は英小文字・数字・_ の3〜20文字で入力してください。");
const passwordSchema = z
  .string()
  .min(8, "パスワードは8文字以上にしてください。")
  .max(72, "パスワードは72文字以内にしてください。");
const nameSchema = z.string().trim().min(1, "表示名を入力してください。").max(40, "表示名は40文字以内にしてください。");

const registerSchema = z.object({ username: usernameSchema, password: passwordSchema, displayName: nameSchema });
const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(20),
  password: z.string().min(1).max(72)
});

const patchSchema = z.object({
  displayName: nameSchema.optional(),
  username: usernameSchema.optional(),
  bio: z.string().max(200).optional(),
  contact: z.string().max(120).optional(),
  profileUrl: z.string().max(200).refine((value) => !value || /^https?:\/\//i.test(value), "URLはhttps:// または http:// から入力してください。").optional(),
  notifyDm: z.boolean().optional()
});

async function loadMe(userId: string) {
  const { data, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, bio, contact, profile_url, avatar_path, notify_dm, sennin_id")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id as string,
    username: data.username as string,
    displayName: data.display_name as string,
    bio: data.bio as string,
    contact: (data.contact ?? "") as string,
    profileUrl: (data.profile_url ?? "") as string,
    hasAvatar: Boolean(data.avatar_path),
    notifyDm: data.notify_dm as boolean,
    sennin: Boolean(data.sennin_id)
  };
}

accounts.post("/auth/register", authLimit, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { data, error } = await sb.rpc("sc_register", {
    p_username: parsed.data.username,
    p_password: parsed.data.password,
    p_name: parsed.data.displayName
  });
  if (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: "そのユーザー名は使われています。" });
      return;
    }
    throw error;
  }
  await startSession(res, data as string);
  res.json({ ok: true });
});

accounts.post("/auth/login", authLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ユーザー名とパスワードを入力してください。" });
    return;
  }
  const { data, error } = await sb.rpc("sc_check_password", {
    p_username: parsed.data.username,
    p_password: parsed.data.password
  });
  if (error) throw error;
  if (!data) {
    res.status(401).json({ error: "ユーザー名かパスワードが違います。" });
    return;
  }
  await startSession(res, data as string);
  res.json({ ok: true });
});

accounts.get("/auth/sennin/login", (_req, res) => {
  const { clientId, authorizationUrl, redirectUri, scope } = config.sennin;
  if (!clientId || !authorizationUrl) {
    res.redirect(`${config.appOrigin}/?auth_error=${encodeURIComponent("仙人アカウントは現在利用できません。")}`);
    return;
  }
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  res.cookie("sc_oauth", `${state}.${verifier}`, { ...cookieBase, maxAge: 10 * 60 * 1000 });
  const url = new URL(authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  res.redirect(url.toString());
});

async function fetchSenninProfile(accessToken: string) {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  const fetchJson = (url: string) =>
    fetch(url, { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const pick = (payload: any) => payload?.user ?? payload?.data ?? payload;
  let data = pick(await fetchJson(config.sennin.userinfoUrl));
  if (!data?.id && !data?.sub) data = pick(await fetchJson(config.sennin.meUrl));
  const id = data?.id ?? data?.sub ?? data?.user_id;
  if (!id) throw new Error("仙人アカウントの情報を取得できませんでした。");
  return {
    id: String(id),
    name: String(data.name ?? data.display_name ?? data.username ?? "仙人ユーザー").slice(0, 40)
  };
}

async function upsertSenninUser(senninId: string, name: string) {
  const found = await sb.from("sc_users").select("id").eq("sennin_id", senninId).maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data.id as string;
  const inserted = await sb
    .from("sc_users")
    .insert({ username: `sn_${crypto.randomBytes(6).toString("hex")}`, display_name: name, sennin_id: senninId })
    .select("id")
    .single();
  if (inserted.error) throw inserted.error;
  return inserted.data.id as string;
}

accounts.get("/auth/sennin/callback", async (req, res) => {
  const fail = (message: string) => {
    res.clearCookie("sc_oauth", cookieBase);
    res.redirect(`${config.appOrigin}/?auth_error=${encodeURIComponent(message)}`);
  };
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const returned = typeof req.query.state === "string" ? req.query.state : "";
  const [state, verifier] = String(req.cookies?.sc_oauth ?? "").split(".");
  if (!code || !state || !verifier || state !== returned) {
    fail("認証情報を確認できませんでした。もう一度お試しください。");
    return;
  }
  try {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    };
    if (config.sennin.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${config.sennin.clientId}:${config.sennin.clientSecret}`).toString("base64")}`;
    }
    const tokenResponse = await fetch(config.sennin.tokenUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.sennin.redirectUri,
        client_id: config.sennin.clientId,
        code_verifier: verifier
      })
    });
    const tokenData: any = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || typeof tokenData.access_token !== "string") {
      throw new Error("トークンを取得できませんでした。");
    }
    const profile = await fetchSenninProfile(tokenData.access_token);
    const userId = await upsertSenninUser(profile.id, profile.name);
    res.clearCookie("sc_oauth", cookieBase);
    await startSession(res, userId);
    res.redirect(`${config.appOrigin}/`);
  } catch (error) {
    fail(error instanceof Error ? error.message.slice(0, 180) : "仙人アカウントへの接続に失敗しました。");
  }
});

accounts.post("/auth/logout", async (req, res) => {
  await endSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, cookieBase);
  res.json({ ok: true });
});

accounts.get("/me", requireAuth, async (_req, res) => {
  const me = await loadMe(currentUserId(res));
  if (!me) {
    res.status(401).json({ error: "ログインしてください。" });
    return;
  }
  res.json(me);
});

accounts.patch("/me", requireAuth, async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const body = parsed.data;
  const update: Record<string, unknown> = {};
  if (body.displayName !== undefined) update.display_name = body.displayName;
  if (body.username !== undefined) update.username = body.username;
  if (body.bio !== undefined) update.bio = body.bio;
  if (body.contact !== undefined) update.contact = body.contact;
  if (body.profileUrl !== undefined) update.profile_url = body.profileUrl;
  if (body.notifyDm !== undefined) update.notify_dm = body.notifyDm;
  const userId = currentUserId(res);
  const { error } = await sb.from("sc_users").update(update).eq("id", userId);
  if (error) {
    if (error.code === "23505") {
      res.status(409).json({ error: "そのユーザー名は使われています。" });
      return;
    }
    throw error;
  }
  res.json(await loadMe(userId));
});

accounts.post("/me/avatar", requireAuth, upload.single("file"), async (req, res) => {
  if (!isAllowedImage(req.file)) {
    res.status(415).json({ error: "JPEG・PNG・WebP・GIF の画像を選んでください。" });
    return;
  }
  const userId = currentUserId(res);
  const path = await saveImage(req.file!, `avatars/${userId}`);
  const { data } = await sb.from("sc_users").select("avatar_path").eq("id", userId).maybeSingle();
  const { error } = await sb.from("sc_users").update({ avatar_path: path }).eq("id", userId);
  if (error) throw error;
  await removeImage(data?.avatar_path ?? null);
  res.json(await loadMe(userId));
});

accounts.get("/users/suggest", requireAuth, async (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,20}$/.test(q)) {
    res.json([]);
    return;
  }
  const { data, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, avatar_path")
    .ilike("username", `${q}%`)
    .neq("id", currentUserId(res))
    .order("username")
    .limit(8);
  if (error) throw error;
  res.json((data ?? []).map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    hasAvatar: Boolean(user.avatar_path)
  })));
});

accounts.get("/users/by-username", requireAuth, async (req, res) => {
  const username = String(req.query.username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    res.status(400).json({ error: "ユーザー名の形式が正しくありません。" });
    return;
  }
  const { data, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, avatar_path")
    .eq("username", username)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "そのユーザーは見つかりません。" });
    return;
  }
  res.json({
    id: data.id,
    username: data.username,
    displayName: data.display_name,
    hasAvatar: Boolean(data.avatar_path)
  });
});

accounts.get("/users/:id/avatar", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).end();
    return;
  }
  const { data } = await sb.from("sc_users").select("avatar_path").eq("id", id).maybeSingle();
  if (!data?.avatar_path) {
    res.status(404).end();
    return;
  }
  const image = await readImage(data.avatar_path);
  if (!image) {
    res.status(404).end();
    return;
  }
  res.setHeader("content-type", image.type);
  res.setHeader("cache-control", "private, no-cache");
  res.send(image.buffer);
});

const noteSchema = z.object({ body: z.string().trim().min(1).max(60) });
const NOTE_MS = 24 * 60 * 60 * 1000;

accounts.get("/me/note", requireAuth, async (_req, res) => {
  const { data, error } = await sb
    .from("sc_notes")
    .select("body, expires_at")
    .eq("user_id", currentUserId(res))
    .maybeSingle();
  if (error) throw error;
  const active = data && new Date(data.expires_at).getTime() > Date.now();
  res.json(active ? { body: data.body, expiresAt: data.expires_at } : null);
});

accounts.put("/me/note", requireAuth, async (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "ノートは1〜60文字で入力してください。" });
    return;
  }
  const expiresAt = new Date(Date.now() + NOTE_MS).toISOString();
  const { error } = await sb.from("sc_notes").upsert(
    { user_id: currentUserId(res), body: parsed.data.body, expires_at: expiresAt },
    { onConflict: "user_id" }
  );
  if (error) throw error;
  res.json({ body: parsed.data.body, expiresAt });
});

accounts.delete("/me/note", requireAuth, async (_req, res) => {
  const { error } = await sb.from("sc_notes").delete().eq("user_id", currentUserId(res));
  if (error) throw error;
  res.json({ ok: true });
});

accounts.get("/users/:id/profile", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) {
    res.status(404).json({ error: "ユーザーが見つかりません。" });
    return;
  }
  const { data, error } = await sb
    .from("sc_users")
    .select("id, username, display_name, bio, contact, profile_url, avatar_path")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    res.status(404).json({ error: "ユーザーが見つかりません。" });
    return;
  }
  const { data: note } = await sb
    .from("sc_notes")
    .select("body, expires_at")
    .eq("user_id", id)
    .maybeSingle();
  const activeNote = note && new Date(note.expires_at).getTime() > Date.now() ? note.body : null;
  res.json({
    id: data.id,
    username: data.username,
    displayName: data.display_name,
    bio: data.bio,
    contact: data.contact ?? "",
    profileUrl: data.profile_url ?? "",
    hasAvatar: Boolean(data.avatar_path),
    note: activeNote
  });
});

accounts.get("/realtime/token", requireAuth, (_req, res) => {
  const { token, expiresIn } = signRealtimeToken(currentUserId(res));
  res.json({ token, expiresIn, url: config.supabaseUrl, anonKey: config.supabaseAnonKey });
});
