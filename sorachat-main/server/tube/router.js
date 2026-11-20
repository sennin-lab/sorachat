// 仙人Tube Plus（Node.js 版）。SoraChat のサーバーに /tube として載せる Router
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { render } from "./lib/render.js";
import { tubePath } from "./lib/base.js";
import { cached } from "./lib/cache.js";
import { fetchJson, getInvidiousInstances, INVIDIOUS_VIDEO_LIST_URL } from "./lib/upstream.js";
import watchRouter from "./routes/watch.js";
import browseRouter from "./routes/browse.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

// SoraChat の中で動くので、SoraChat のCSP（インラインのスクリプトを止める）は外し、転送先は /tube の下に付ける
router.use((req, res, next) => {
  res.removeHeader("Content-Security-Policy");
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    args[args.length - 1] = tubePath(args[args.length - 1]);
    return redirect(...args);
  };
  next();
});
// 仙人Tube は仙人ソラチャットの画面の中（iframe）でも開くので、フレームの禁止は付けない
router.use("/img", express.static(path.join(here, "img")));

// 画面（テンプレートを描画するだけのページ）
const PAGES = {
  "/games": "games.html",
  "/block.html": "block.html",
  "/tumu.html": "tumu.html",
  "/2048.html": "2048.html",
  "/gameview": "gameview.html",
  "/other": "other.html",
  "/editor": "editor.html",
  "/other-sites": "other-sites.html",
  "/about": "about.html",
  "/help": "help.html",
  "/subscriptions": "subscriptions.html",
  "/bbs": "bbs.html",
  "/downloader": "bbs.html",
  "/setting": "setting.html",
};
for (const [route, template] of Object.entries(PAGES)) {
  router.get(route, (req, res, next) => {
    try {
      render(req, res, template, {});
    } catch (error) {
      next(error);
    }
  });
}

router.get("/", (req, res) => {
  const welcomeSeen = req.cookies?.welcome_seen === "true";
  render(req, res, welcomeSeen ? "home.html" : "welcome.html", {});
});

router.get("/history", (req, res) => {
  let list = [];
  try {
    list = JSON.parse(req.cookies?.history || "[]");
  } catch {
    list = [];
  }
  render(req, res, "history.html", { history: Array.isArray(list) ? list.reverse() : [] });
});

router.get("/history/clear", (req, res) => {
  res.clearCookie("history");
  res.redirect("/history");
});

// 稼働状況（インスタンスごとに /api/v1/stats を確かめる）
router.get("/status", async (req, res, next) => {
  try {
    const instances = await getInvidiousInstances(INVIDIOUS_VIDEO_LIST_URL);
    const results = await Promise.all(
      instances.map(async (instance) => {
        const started = Date.now();
        try {
          const data = await fetchJson(`${instance}/api/v1/stats`, { timeout: 3000 });
          return {
            instance,
            status: "Online",
            latency: `${Date.now() - started}ms`,
            version: data?.software?.version || "unknown",
            users: data?.usage?.users?.total ?? 0,
          };
        } catch {
          return { instance, status: "Offline", latency: "-", version: "-", users: "-" };
        }
      })
    );
    render(req, res, "status.html", { instances: results });
  } catch (error) {
    next(error);
  }
});

// 旧 API の「おすすめ」「チャンネル情報」などは browse.js にある
router.use(watchRouter);
router.use(browseRouter);

// 404
router.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ detail: "Not Found" });
  return render(req, res, "404.html", {}, 404);
});

// 想定外のエラー
router.use((error, req, res, _next) => {
  console.error("[error]", req.method, req.originalUrl, error);
  if (res.headersSent) return;
  if (req.path.startsWith("/api/")) return res.status(500).json({ detail: "Internal Server Error" });
  try {
    render(req, res, "apitimeout.html", {}, 504);
  } catch {
    res.status(500).send("Internal Server Error");
  }
});

export default router;
