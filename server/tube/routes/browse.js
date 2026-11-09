// 検索・チャンネル・プレイリスト・サジェスト・APIの小さな口
import { Router } from "express";
import { render } from "../lib/render.js";
import { cached } from "../lib/cache.js";
import { fetchJson, getInvidiousInstances, invidious } from "../lib/upstream.js";
import { fetchChannel, fetchPlaylist, searchVideos } from "../lib/youtube.js";
import { asyncRoute } from "../lib/util.js";

const router = Router();

const escapeHtml = (text) =>
  String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};

const unavailable = async (req, res) =>
  render(req, res, "apiallerror.html", { instances: await getInvidiousInstances() }, 503);

router.get(
  "/search",
  asyncRoute(async (req, res) => {
    const query = String(req.query.q || "").trim();
    const type = String(req.query.type || "video");
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const forceInstance = req.query.force_instance ? String(req.query.force_instance) : null;

    const ctx = { query, type, page, results: [], shorts_results: [] };
    if (!query) return render(req, res, "search.html", ctx);

    try {
      ctx.results = await cached(`search:${type}:${page}:${query}`, 3 * 60_000, () =>
        searchVideos(query, { page, type, forceInstance })
      );
      return render(req, res, "search.html", ctx);
    } catch {
      return unavailable(req, res);
    }
  })
);

router.get(
  "/channel/:ucid",
  asyncRoute(async (req, res) => {
    const ucid = req.params.ucid;
    const sortBy = String(req.query.sort_by || "newest");
    const tab = String(req.query.tab || "videos");
    const forceInstance = req.query.force_instance ? String(req.query.force_instance) : null;
    try {
      const channel = await cached(`ch:${ucid}:${sortBy}:${forceInstance || "auto"}`, 5 * 60_000, () =>
        fetchChannel(ucid, { sortBy, forceInstance })
      );
      return render(req, res, "channel.html", { ...channel, sort_by: sortBy, tab });
    } catch {
      return unavailable(req, res);
    }
  })
);

router.get(
  "/playlist",
  asyncRoute(async (req, res) => {
    const listId = String(req.query.list || "");
    if (!listId) return res.redirect("/");
    const data = await fetchPlaylist(listId, {
      forceInstance: req.query.force_instance ? String(req.query.force_instance) : null,
    });
    if (!data) return unavailable(req, res);
    return render(req, res, "playlist.html", {
      playlistId: listId,
      title: data.title || "",
      author: data.author || "",
      authorId: data.authorId || "",
      description: data.descriptionHtml || escapeHtml(data.description || "").replace(/\n/g, "<br>"),
      videos: (data.videos || []).map((v) => ({ videoId: v.videoId, title: v.title, author: v.author })),
    });
  })
);

// 検索のサジェスト（Google の候補を取る）
router.get(
  "/suggest",
  asyncRoute(async (req, res) => {
    const keyword = String(req.query.keyword || "");
    const list = await cached(`suggest:${keyword}`, 10 * 60_000, async () => {
      const params = new URLSearchParams({ client: "firefox", q: keyword, hl: "ja", ie: "utf-8", oe: "utf-8" });
      const data = await fetchJson(`https://suggestqueries.google.com/complete/search?${params}`, { timeout: 2000 });
      return Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    }).catch(() => []);
    res.json(list ?? []);
  })
);

// トップの「おすすめ」：検索履歴のキーワードで動画を集める
router.get(
  "/api/recommended",
  asyncRoute(async (req, res) => {
    let history = [];
    try {
      history = JSON.parse(req.cookies?.search_history || "[]");
    } catch {
      history = [];
    }
    const keywords = Array.isArray(history) && history.length
      ? history.slice(-5).map(String)
      : ["ボカロ", "VTuber", "ゲーム実況", "音楽", "ニュース"];

    const lists = await Promise.all(keywords.map((kw) => searchVideos(kw).catch(() => [])));
    const seen = new Set();
    const videos = [];
    for (const item of lists.flat()) {
      if (item?.type !== "video" || !item.videoId || seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      videos.push(item);
    }
    res.json(shuffle(videos).slice(0, 24));
  })
);

router.get(
  "/api/channel_info",
  asyncRoute(async (req, res) => {
    const ucid = String(req.query.ucid || "");
    try {
      const { data } = await invidious(`/channels/${encodeURIComponent(ucid)}`);
      const icon = data.authorThumbnails?.length ? data.authorThumbnails[data.authorThumbnails.length - 1].url : "";
      res.json({
        ucid,
        name: data.author || ucid,
        icon,
        handle: data.authorUrl || "",
        description: data.description || "",
      });
    } catch {
      res.json({ ucid, name: ucid, icon: "", handle: "", description: "" });
    }
  })
);

// 教育用の埋め込み URL（配布されている鍵の設定ファイルから作る）
const EDUCATION_SOURCES = {
  "Education - Toka_Kun_-1": "https://raw.githubusercontent.com/toka-kun/Education/refs/heads/main/keys/key1.json",
  "Education - Toka_Kun_-2": "https://raw.githubusercontent.com/toka-kun/Education/refs/heads/main/keys/key2.json",
  "Education - Toka_Kun_-3": "https://raw.githubusercontent.com/toka-kun/Education/refs/heads/main/keys/key3.json",
  "Education - Toka_Kun_-4": "https://raw.githubusercontent.com/toka-kun/Education/refs/heads/main/keys/key4.json",
  "Education - siawaseok": "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json",
  "Education - wakame": "https://raw.githubusercontent.com/wakame02/wktopu/refs/heads/main/edu.text",
  "Education - woolisbest4520-1": "https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/1.txt",
  "Education - woolisbest4520-2": "https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/2.txt",
  "Education - woolisbest4520-3": "https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/3.txt",
};

router.get(
  "/api/get_education_url",
  asyncRoute(async (req, res) => {
    const videoId = String(req.query.video_id || "");
    const source = String(req.query.source || "");
    try {
      if (!EDUCATION_SOURCES[source]) throw new Error(`未知のソース名です: ${source}`);
      const raw = EDUCATION_SOURCES[source];
      const res2 = await fetch(raw, { signal: AbortSignal.timeout(10000) });
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      let params = "";
      if (source.startsWith("Education - Toka_Kun")) params = (await res2.json()).result || "";
      else if (source === "Education - siawaseok") params = (await res2.json()).params || "";
      else params = (await res2.text()).trim();
      res.json({ url: `https://www.youtubeeducation.com/embed/${encodeURIComponent(videoId)}${params}` });
    } catch (error) {
      res.json({ error: error.message });
    }
  })
);

export default router;
