// 動画ページ（/watch・/shorts・/embed）とサムネイル
import { Router } from "express";
import { render } from "../lib/render.js";
import { cached } from "../lib/cache.js";
import { fetchBuffer, getInvidiousInstances } from "../lib/upstream.js";
import {
  buildStreams,
  descriptionFor,
  fetchComments,
  fetchPlaylist,
  fetchVideoInfo,
  recommendedFor,
} from "../lib/youtube.js";
import { VIDEO_ID_RE, asyncRoute, withTimeout } from "../lib/util.js";

const router = Router();

const nocookieUrl = (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;

router.get(
  "/watch",
  asyncRoute(async (req, res) => {
    const v = String(req.query.v || "");
    if (!VIDEO_ID_RE.test(v)) return res.redirect("/");

    const playlistId = req.query.list ? String(req.query.list) : null;
    const forceInstance = req.query.force_instance ? String(req.query.force_instance) : null;

    // 動画情報は一番大事なので長めに待つ。コメントとプレイリストは短く待つ
    const [info, comments, playlist] = await Promise.all([
      withTimeout(fetchVideoInfo(v, { forceInstance }), 12000),
      withTimeout(fetchComments(v, { forceInstance }), 4000, []),
      withTimeout(fetchPlaylist(playlistId, { forceInstance }), 4000),
    ]);

    if (!info) {
      return render(req, res, "apiallerror.html", { instances: await getInvidiousInstances() }, 503);
    }

    const streams = buildStreams(info);
    const playlistVideos = (playlist?.videos || []).map((item) => ({
      videoId: item.videoId,
      title: item.title,
      author: item.author,
    }));

    return render(req, res, "watch.html", {
      videoid: v,
      nocookie_url: nocookieUrl(v),
      video_title: info.title || "",
      videourls: streams.videoUrls,
      streamUrls: streams.streamUrls,
      author: info.author || "",
      author_id: info.authorId || "",
      author_icon: info.authorIcon || "",
      subscribers_count: info.subCountText || "非公開",
      view_count: info.viewCount ?? 0,
      like_count: info.likeCount ?? 0,
      description: descriptionFor(info),
      published: info.publishedText || "",
      comments,
      recommended_videos: recommendedFor(info),
      playlist_videos: playlistVideos,
      playlist_id: playlistId,
      playlist_title: playlist?.title || "",
      info_api_used: info.api_used,
      stream_api_used: info.api_used,
      api_used: info.api_used,
    });
  })
);

router.get(
  "/shorts/:v",
  asyncRoute(async (req, res) => {
    const v = req.params.v;
    if (!VIDEO_ID_RE.test(v)) return res.redirect("/");
    const forceInstance = req.query.force_instance ? String(req.query.force_instance) : null;

    const [info, comments] = await Promise.all([
      withTimeout(fetchVideoInfo(v, { forceInstance }), 12000),
      withTimeout(fetchComments(v, { forceInstance }), 4000, []),
    ]);
    if (!info) {
      return render(req, res, "apiallerror.html", { instances: await getInvidiousInstances() }, 503);
    }
    const streams = buildStreams(info);
    return render(req, res, "short.html", {
      videoid: v,
      nocookie_url: nocookieUrl(v),
      video_title: info.title || "",
      videourls: streams.videoUrls,
      author: info.author || "",
      view_count: info.viewCount ?? 0,
      like_count: info.likeCount ?? 0,
      description: descriptionFor(info),
      comments,
      info_api_used: info.api_used,
      stream_api_used: info.api_used,
      api_used: info.api_used,
    });
  })
);

// 埋め込み（プレイヤーは画面側の JavaScript が動かす）
router.get("/embed/:id", (req, res) => render(req, res, "embed.html", { videoid: req.params.id }));
router.get("/embed", (req, res) => render(req, res, "embed.html", { videoid: String(req.query.v || "") }));

router.get("/select", (req, res) => render(req, res, "select.html", { video_id: String(req.query.v || "") }));

// サムネイル（YouTube の画像を中継して、30分キャッシュする）
router.get(
  ["/proxy/thumb", "/thumbnail"],
  asyncRoute(async (req, res) => {
    const v = String(req.query.v || "");
    if (!VIDEO_ID_RE.test(v)) return res.status(404).end();
    const image = await cached(`thumb:${v}`, 30 * 60_000, () =>
      fetchBuffer(`https://i.ytimg.com/vi/${encodeURIComponent(v)}/mqdefault.jpg`).catch(() => null)
    );
    if (!image) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=1800").type("image/jpeg").send(image);
  })
);

export default router;
