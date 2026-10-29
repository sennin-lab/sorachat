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
import { friends } from "./friends.js";
import { openChats } from "./openchat.js";
import { push } from "./push.js";
import { attachRealtime } from "./realtime.js";

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "SoraChat" });
});

app.use("/api", accounts);
app.use("/api", dm);
app.use("/api", friends);
app.use("/api", push);
app.use("/api", openChats);
app.use("/api", admin);
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
  console.error(error);
  res.status(500).json({ error: "サーバーでエラーが発生しました。" });
});

const server = createServer(app);
attachRealtime(server);

server.listen(config.port, "0.0.0.0", () => {
  console.log(`SoraChat listening on ${config.port}`);
});
