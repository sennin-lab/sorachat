import { stamps } from "./stamps.js";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { accounts } from "./accounts.js";
import { admin } from "./admin.js";
import { config } from "./config.js";
import { dm } from "./dm.js";
import { resumeGameTimers } from "./games.js";
import { friends } from "./friends.js";
import { openChats } from "./openchat.js";
import { push } from "./push.js";
import { senninai } from "./senninai.js";
import { blocks } from "./blocks.js";
import { calls } from "./calls.js";
import { BlockedError } from "./messages.js";
import { attachRealtime } from "./realtime.js";
import { initializeMaintenanceSettings, maintenanceGate } from "./maintenance.js";
import { getStatus } from "./status.js";
import { store } from "./store.js";
import { senninPay } from "./senninpay.js";
import { senningames } from "./senningames.js";
import { adminPay } from "./adminPay.js";
import { studio } from "./studio.js";
import { studioAdmin } from "./studioAdmin.js";
import { studioReviews } from "./studioReviews.js";
import tubeRouter from "./tube/router.js";
import { ipBanGate, reloadIpBans } from "./ipBans.js";
import { referral } from "./referral.js";

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

// BAN された IP は、管理者と状態表示を除いて /api を使えない（メンテナンスより前に止める）
app.use(ipBanGate);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "SoraChat" });
});

// サービス稼働状況（いつでも見られる。メンテナンス中も止めない）
app.get("/api/status", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await getStatus());
});

// メンテナンスモードは管理者パネルから即時切り替え可能。
// /api/admin と /admin はメンテナンス中も利用できる。
app.use(maintenanceGate);

// 仙人Tube Plus（/tube の中で動く。SoraChat と同じ場所から開く）
app.use("/tube", tubeRouter);

app.use("/api", accounts);
app.use("/api", referral);
app.use("/api", dm);
app.use("/api", friends);
app.use("/api", push);
app.use("/api", openChats);
app.use("/api", senninai);
app.use("/api", stamps);
app.use("/api", blocks);
app.use("/api", calls);
app.use("/api", store);
app.use("/api", senninPay);
app.use("/api", senningames);
app.use("/api", studio);
app.use("/api", studioReviews);
app.use("/api", studioAdmin);
app.use("/api", admin);
app.use("/api", adminPay);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "見つかりません。" });
});

const dist = path.join(root, "dist");
if (existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "ファイルが大きすぎます。" });
    return;
  }
  if (error instanceof BlockedError) {
    res.status(403).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "サーバーでエラーが発生しました。" });
});

const server = createServer(app);
attachRealtime(server);

server.listen(config.port, "0.0.0.0", () => {
  console.log(`SoraChat listening on ${config.port}`);
  initializeMaintenanceSettings().catch((error) => console.error("メンテナンス設定の初期化に失敗しました", error));
  reloadIpBans().catch((error) => console.error("IP BAN の一覧を読めませんでした", error));
  // 再起動前に始まったミニゲームの制限時間を引き継ぐ
  resumeGameTimers().catch((error) => console.error("ミニゲームの制限時間を引き継げませんでした", error));
});
