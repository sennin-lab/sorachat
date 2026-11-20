import "dotenv/config";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を設定してください。`);
  return value;
};

// 環境変数を読む。前後の空白・改行や、貼り付けで入った引用符（"..." / '...'）は取り除く。
// （ホスティングの画面に貼ったとき、末尾の改行や引用符が入って、IDやシークレットが合わなくなるのを防ぐ）
const env = (name: string): string => {
  let value = (process.env[name] ?? "").trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    value = value.slice(1, -1).trim();
  }
  return value;
};

// 仙人アカウントの場所（例: https://account.example.com）。末尾のスラッシュは取り除く
const senninBase = env("SENNIN_BASE_URL").replace(/\/+$/, "");

// 仙人アカウントの各URL。個別の環境変数があればそれを使い、なければ SENNIN_BASE_URL から決める
const senninUrl = (override: string, path: string) => {
  if (override) return override;
  return senninBase ? `${senninBase}${path}` : "";
};

// 仙人アカウントのAPI（ポイント）の場所は、個別指定 → トークンのURLと同じサーバー → SENNIN_BASE_URL の順で決める
const senninApi = (path: string, override: string) => {
  if (override) return override;
  const tokenUrl = senninUrl(env("SENNIN_TOKEN_URL"), "/oauth/token");
  try {
    return tokenUrl ? new URL(path, tokenUrl).toString() : "";
  } catch {
    return "";
  }
};

// このアプリ（ソラチャット）自身のURL。仙人アカウントから戻ったあとの飛び先に使う。
// APP_ORIGIN に Google Apps Script のURL（script.google.com/.../exec）が入っていると、戻り先がそこになってしまうため、
// そのときは使わず、リダイレクトURI（このサーバー自身のURL）の origin を使う。
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
const isGoogleScript = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === "script.google.com" || host.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
};
const isLocalOrigin = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin);
const appOrigin = (() => {
  const given = env("APP_ORIGIN").replace(/\/+$/, "");
  if (given && !isGoogleScript(given)) return given;
  const fromRedirect = originOf(env("SENNIN_REDIRECT_URI"));
  if (fromRedirect && !isLocalOrigin(fromRedirect) && !isGoogleScript(fromRedirect)) return fromRedirect;
  return "http://localhost:5173";
})();

// 仙人ストアの「運営」の仙人アカウントに紐づくソラチャットのユーザーID（sc_users.id）。
// 運営へ返すポイント（自分の作品を買ったときの売上など）の受け取り先。未設定なら自分の作品は買えません。
const operatorUserId = env("OPERATOR_USER_ID");

// ストアの許可（ポイントの読み書き）
const senninStoreScope = env("SENNIN_STORE_SCOPE") || "profile points:read points:write";
const senninScope = env("SENNIN_SCOPE") || "profile email";
// ログイン特典（初回ログインで30ポイント）を使うか。使うとログイン時にポイントの許可も求める
// （points:write は仙人アカウント側の管理者の承認が必要。承認前に有効にすると、ログインの許可画面でエラーになるおそれがあるため既定はオフ）
const senninLoginBonus = ["on", "true", "1", "yes"].includes(env("SENNIN_LOGIN_BONUS").toLowerCase());
const senninLoginScope = env("SENNIN_LOGIN_SCOPE") || (senninLoginBonus ? senninStoreScope : senninScope);

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  appOrigin,
  operatorUserId,
  supabaseUrl: need("SUPABASE_URL"),
  supabaseServiceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseAnonKey: need("SUPABASE_ANON_KEY"),
  supabaseJwtSecret: need("SUPABASE_JWT_SECRET"),
  // 画像・ファイルの保存先（Turso）
  tursoUrl: need("TURSO_DATABASE_URL"),
  tursoAuthToken: need("TURSO_AUTH_TOKEN"),
  sennin: {
    clientId: env("SENNIN_CLIENT_ID"),
    clientSecret: env("SENNIN_CLIENT_SECRET"),
    // 空のときは、このアプリの戻り先（/api/auth/sennin/callback）を使う。仙人アカウントに登録したリダイレクトURIと完全一致させること
    redirectUri: env("SENNIN_REDIRECT_URI") || `${appOrigin.replace(/\/+$/, "")}/api/auth/sennin/callback`,
    authorizationUrl: senninUrl(env("SENNIN_AUTHORIZATION_URL"), "/oauth/authorize"),
    tokenUrl: senninUrl(env("SENNIN_TOKEN_URL"), "/oauth/token"),
    userinfoUrl: senninUrl(env("SENNIN_USERINFO_URL"), "/oauth/userinfo"),
    meUrl: senninUrl(env("SENNIN_ME_URL"), "/api/v1/me"),
    scope: senninScope,
    // ログイン（仙人アカウントで続行）で要求する許可。ログイン特典を使うときは points も含める
    loginScope: senninLoginScope,
    loginBonus: senninLoginBonus,
    // ストア（ポイント）用の許可。ログインとは別に、「連携」のときだけ要求する
    // points:write は管理者の承認が必要。承認されていないと連携画面でエラーになる
    storeScope: senninStoreScope,
    pointsUrl: senninApi("/api/v1/points", env("SENNIN_POINTS_URL")),
    pointsAdjustUrl: senninApi("/api/v1/points/adjust", env("SENNIN_POINTS_ADJUST_URL"))
  },
  // senninai（AIチャット）の回答元（UserLocal の senninai API）。既定は作者の公開エンドポイント
  senninAi: {
    baseUrl: (process.env.SENNIN_AI_URL || "https://senninai.hiroki2013403.workers.dev").replace(/\/+$/, "")
  },
  // 管理者パネル（/admin/login）のパスワード。未設定なら管理者ログインは使えません
  adminPassword: process.env.ADMIN_PASSWORD || "",
  // メンテナンスモード。MAINTENANCE_MODE=on で有効（変更はサーバーの再起動で反映）
  maintenance: {
    enabled: ["on", "true", "1", "yes"].includes((process.env.MAINTENANCE_MODE || "").trim().toLowerCase()),
    message: process.env.MAINTENANCE_MESSAGE?.trim() || "メンテナンス中ですしばらくお待ちください。"
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "mailto:admin@example.com"
  }
};

// 仙人アカウントの設定で足りないもの（環境変数の名前）を返す。空なら、連携に必要な設定はそろっている
export function missingSenninSettings(): string[] {
  const { clientId, clientSecret, authorizationUrl, tokenUrl, userinfoUrl } = config.sennin;
  const missing: string[] = [];
  if (!clientId) missing.push("SENNIN_CLIENT_ID");
  if (!clientSecret) missing.push("SENNIN_CLIENT_SECRET");
  if (!authorizationUrl) missing.push("SENNIN_AUTHORIZATION_URL（または SENNIN_BASE_URL）");
  if (!tokenUrl) missing.push("SENNIN_TOKEN_URL（または SENNIN_BASE_URL）");
  if (!userinfoUrl) missing.push("SENNIN_USERINFO_URL（または SENNIN_BASE_URL）");
  return missing;
}
