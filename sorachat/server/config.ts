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
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "mailto:admin@example.com"
  }
};
