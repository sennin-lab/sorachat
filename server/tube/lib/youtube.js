// 動画・チャンネル・プレイリスト・検索の取得と、テンプレート用の形への変換
import { invidious, piped } from "./upstream.js";

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
};

const escapeHtml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const lastThumb = (list) => (Array.isArray(list) && list.length ? list[list.length - 1]?.url ?? "" : "");

// ---- 動画情報 ----

// Piped の形を、Invidious と同じ形に揃える（Invidious が使えないときの予備）
function pipedToInvidiousShape(p, id) {
  const container = (s) =>
    String(s.mimeType?.split("/")[1] || s.format || "mp4")
      .split(";")[0]
      .toLowerCase()
      .replace(/^mpeg4$/, "mp4")
      .replace(/[^a-z0-9]/g, "");
  const videoStreams = p.videoStreams || [];
  return {
    videoId: id,
    title: p.title || "",
    author: p.uploader || "",
    authorId: String(p.uploaderUrl || "").split("/").pop() || "",
    authorIcon: p.uploaderAvatar || "",
    authorThumbnails: p.uploaderAvatar ? [{ url: p.uploaderAvatar }] : [],
    description: p.description || "",
    descriptionHtml: "",
    viewCount: p.views || 0,
    likeCount: p.likes || 0,
    publishedText: p.uploadDate || "",
    subCountText: p.uploaderSubscriberCount ? String(p.uploaderSubscriberCount) : "非公開",
    recommendedVideos: (p.relatedStreams || [])
      .filter((r) => String(r.url || "").startsWith("/watch"))
      .map((r) => ({
        videoId: new URL(`https://x${r.url}`).searchParams.get("v") || "",
        title: r.title || "",
        author: r.uploaderName || "",
        viewCountText: r.views ? `${r.views}回視聴` : "",
        lengthSeconds: r.duration || 0,
        videoThumbnails: r.thumbnail ? [{ url: r.thumbnail }] : [],
      })),
    formatStreams: videoStreams
      .filter((s) => !s.videoOnly && s.url)
      .map((s) => ({ url: s.url, quality: s.quality, qualityLabel: s.quality, container: container(s) })),
    adaptiveFormats: [
      ...videoStreams
        .filter((s) => s.videoOnly && s.url)
        .map((s) => ({ url: s.url, type: s.mimeType || "video/mp4", qualityLabel: s.quality, container: container(s) })),
      ...(p.audioStreams || [])
        .filter((s) => s.url)
        .map((s) => ({ url: s.url, type: s.mimeType || "audio/mp4", bitrate: s.bitrate || 0 })),
    ],
    api_used: "Piped",
  };
}

export async function fetchVideoInfo(id, { forceInstance = null } = {}) {
  try {
    const { data, instance } = await invidious(`/videos/${encodeURIComponent(id)}`, {}, { forceInstance });
    return { ...data, api_used: `Invidious (${hostOf(instance)})` };
  } catch {
    try {
      const { data } = await piped(`/streams/${encodeURIComponent(id)}`);
      return pipedToInvidiousShape(data, id);
    } catch {
      return null;
    }
  }
}

// 再生用の URL を作る（映像＋音声の入った形式を優先し、無ければ音声を別に付ける）
export function buildStreams(info) {
  const heightOf = (f) => parseInt(String(f.qualityLabel || f.quality || "").match(/\d+/)?.[0] || "0", 10);
  const adaptive = info.adaptiveFormats || [];
  const bestAudio = adaptive
    .filter((f) => String(f.type || "").startsWith("audio/") && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  let picked = (info.formatStreams || []).filter((f) => f.url);
  let withAudio = "";
  if (!picked.length) {
    picked = adaptive.filter((f) => String(f.type || "").startsWith("video/") && f.url);
    withAudio = bestAudio?.url || "";
  }
  picked.sort((a, b) => heightOf(b) - heightOf(a));

  const streamUrls = picked.map((f) => ({
    url: f.url,
    resolution: f.qualityLabel || f.quality || "",
    format: String(f.container || "mp4").toUpperCase(),
    audioUrl: withAudio,
  }));
  return { streamUrls, videoUrls: streamUrls.map((s) => s.url) };
}

export async function fetchComments(id, { forceInstance = null } = {}) {
  try {
    const { data } = await invidious(`/comments/${encodeURIComponent(id)}`, {}, { forceInstance });
    return (data.comments || []).map((c) => ({
      author: c.author || "",
      authorId: c.authorId || "",
      authorThumbnails: c.authorThumbnails || [],
      authorThumbnail: lastThumb(c.authorThumbnails),
      publishedText: c.publishedText || "",
      contentHtml: c.contentHtml || escapeHtml(c.content || ""),
      likeCount: c.likeCount || 0,
    }));
  } catch {
    return [];
  }
}

export async function fetchPlaylist(id, { forceInstance = null } = {}) {
  if (!id) return null;
  try {
    const { data } = await invidious(`/playlists/${encodeURIComponent(id)}`, {}, { forceInstance });
    return data;
  } catch {
    return null;
  }
}

export const recommendedFor = (info) =>
  (info?.recommendedVideos || []).map((item) => ({
    video_id: item.videoId || "",
    title: item.title || "",
    author: item.author || "",
    view_count_text: item.viewCountText || "",
    thumbnail: lastThumb(item.videoThumbnails),
  }));

// 説明文。Invidious の HTML があればそれを使い、無ければ安全に変換する
export const descriptionFor = (info) =>
  info?.descriptionHtml || escapeHtml(info?.description || "").replace(/\n/g, "<br>");

// ---- 検索・チャンネル・プレイリスト ----

export async function searchVideos(q, { page = 1, type = "video", forceInstance = null } = {}) {
  const { data } = await invidious("/search", { q, page, type }, { forceInstance });
  return Array.isArray(data) ? data : [];
}

export async function fetchChannel(ucid, { sortBy = "newest", forceInstance = null } = {}) {
  const id = encodeURIComponent(ucid);
  const sortMap = { newest: "newest", oldest: "oldest", popular: "popular" };
  const [info, videos, shorts, playlists] = await Promise.allSettled([
    invidious(`/channels/${id}`, {}, { forceInstance }),
    invidious(`/channels/${id}/videos`, { sort_by: sortMap[sortBy] || "newest" }, { forceInstance }),
    invidious(`/channels/${id}/shorts`, {}, { forceInstance }),
    invidious(`/channels/${id}/playlists`, {}, { forceInstance }),
  ]);
  const ch = info.status === "fulfilled" ? info.value.data : null;
  const listOf = (res, key) => (res.status === "fulfilled" ? res.value.data?.[key] || [] : []);
  if (!ch && videos.status !== "fulfilled") throw new Error("チャンネルを取得できませんでした");

  return {
    ucid,
    author: ch?.author || ucid,
    author_icon: lastThumb(ch?.authorThumbnails),
    banner_url: lastThumb(ch?.authorBanners),
    handle: ch?.authorUrl || "",
    video_count: ch?.totalVideos ?? null,
    sub_count: ch?.subCountText || "",
    description: ch?.descriptionHtml || escapeHtml(ch?.description || "").replace(/\n/g, "<br>"),
    videos: listOf(videos, "videos"),
    shorts: listOf(shorts, "videos"),
    playlists: listOf(playlists, "playlists"),
    community: [],
  };
}
