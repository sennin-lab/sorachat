import "dotenv/config";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を設定してください。`);
  return value;
};

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  appOrigin: process.env.APP_ORIGIN || "http://localhost:5173",
  supabaseUrl: need("SUPABASE_URL"),
  supabaseServiceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseAnonKey: need("SUPABASE_ANON_KEY"),
  supabaseJwtSecret: need("SUPABASE_JWT_SECRET"),
  // 画像・ファイルの保存先（Turso）
  tursoUrl: need("TURSO_DATABASE_URL"),
  tursoAuthToken: need("TURSO_AUTH_TOKEN"),
  sennin: {
    clientId: process.env.SENNIN_CLIENT_ID || "",
    clientSecret: process.env.SENNIN_CLIENT_SECRET || "",
    redirectUri: process.env.SENNIN_REDIRECT_URI || "",
    authorizationUrl: process.env.SENNIN_AUTHORIZATION_URL || "",
    tokenUrl: process.env.SENNIN_TOKEN_URL || "",
    userinfoUrl: process.env.SENNIN_USERINFO_URL || "",
    meUrl: process.env.SENNIN_ME_URL || "",
    scope: process.env.SENNIN_SCOPE || "profile email"
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
