import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { sb } from "./supabase.js";

export const SESSION_COOKIE = "sc_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.nodeEnv === "production",
  path: "/"
};

export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export async function startSession(res: Response, userId: string) {
  const token = randomToken();
  const { error } = await sb.from("sc_sessions").insert({
    token_hash: sha256(token),
    user_id: userId,
    expires_at: new Date(Date.now() + SESSION_MS).toISOString()
  });
  if (error) throw error;
  res.cookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: SESSION_MS });
}

export async function endSession(token: unknown) {
  if (typeof token === "string" && token) {
    await sb.from("sc_sessions").delete().eq("token_hash", sha256(token));
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || !token) {
      res.status(401).json({ error: "ログインしてください。" });
      return;
    }
    const { data, error } = await sb
      .from("sc_sessions")
      .select("user_id, expires_at")
      .eq("token_hash", sha256(token))
      .maybeSingle();
    if (error) throw error;
    if (!data || new Date(data.expires_at).getTime() < Date.now()) {
      res.status(401).json({ error: "セッションが切れました。再ログインしてください。" });
      return;
    }
    res.locals.userId = data.user_id;
    next();
  } catch (error) {
    next(error);
  }
}

export const currentUserId = (res: Response) => res.locals.userId as string;

export function signRealtimeToken(userId: string, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ sub: userId, role: "authenticated", aud: "authenticated", iss: "sorachat", iat: now, exp: now + ttlSeconds });
  const signature = crypto.createHmac("sha256", config.supabaseJwtSecret).update(`${header}.${payload}`).digest("base64url");
  return { token: `${header}.${payload}.${signature}`, expiresIn: ttlSeconds };
}
