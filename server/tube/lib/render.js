// テンプレートの描画（Jinja2 のテンプレートを nunjucks で読む）
import path from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";
import { withBase } from "./base.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(here, "..", "templates");

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(TEMPLATE_DIR), {
  autoescape: true,
  noCache: process.env.NODE_ENV !== "production",
});

// Jinja2 にあって nunjucks に無いものを補う
env.addGlobal("range", (n) => Array.from({ length: Number(n) }, (_, i) => i));
// Jinja2 の「//」（切り捨て割り算）の代わり
env.addGlobal("fdiv", (a, b) => Math.floor(Number(a) / Number(b)));
// "%02d:%02d" | format(m, s) の代わり
env.addFilter("format", (fmt, ...args) =>
  String(fmt).replace(/%0?(\d*)d/g, (_, width) => {
    const value = String(Math.trunc(Number(args.shift()) || 0));
    return width ? value.padStart(Number(width), "0") : value;
  })
);
// Jinja2 の tojson（JavaScript の中に安全に埋め込める JSON）
env.addFilter(
  "tojson",
  (value) => new nunjucks.runtime.SafeString(JSON.stringify(value ?? null).replace(/</g, "\\u003c"))
);

// テンプレートの request.query_params.get("…") に合わせた小さな request
function requestShim(req) {
  return {
    url: req.originalUrl,
    path: req.path,
    cookies: req.cookies || {},
    query_params: { get: (key, fallback = null) => (req.query[key] ?? fallback) },
  };
}

export function render(req, res, name, context = {}, status = 200) {
  const html = withBase(env.render(name, { request: requestShim(req), ...context }));
  res.status(status).type("html").send(html);
}

export function renderString(name, context = {}) {
  return env.render(name, context);
}
