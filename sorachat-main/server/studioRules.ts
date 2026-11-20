// senninstudio の自動チェック（審査なしで公開するための仕組み）。
// DB や通信には触れない純粋な関数だけを置く（テストしやすいように）。

export const STUDIO_KINDS = ["stamp_pack", "theme", "quiz", "ai_style", "extension"] as const;
export type StudioKind = (typeof STUDIO_KINDS)[number];

export const PRICE_MIN = 10;
export const PRICE_MAX = 1000;
export const STAMP_MAX_COUNT = 24;
export const STAMP_MAX_BYTES = 1024 * 1024; // 1MB
export const THUMB_MAX_BYTES = 2 * 1024 * 1024; // 2MB
export const STAMP_MAX_SIDE = 512;
export const STAMP_MIN_SIDE = 16;
export const QUIZ_MIN_QUESTIONS = 5; // 対戦の5問に足りるように
export const QUIZ_MAX_QUESTIONS = 50;
// 拡張機能のコードは、HTML・CSS・JavaScript を合わせて 15万文字まで（文字数）
export const EXT_TOTAL_MAX = 150_000;
// 禁止語（最低限の例）。運営が増やしてください。ここに当たる文字列は公開できません。
export const BLOCKED_WORDS = ["死ね", "殺してやる", "自殺しろ"];

// ---------- 画像 ----------

export type SniffedImage = { type: "png" | "gif" | "webp" | "jpeg"; width: number | null; height: number | null };

// ファイルの中身（先頭のバイト列）で形式を判定し、分かるなら縦横のピクセル数も読む。拡張子や申告の型は信用しない
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { type: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buf.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      return { type: "webp", width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") {
      return { type: "webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return { type: "webp", width: null, height: null };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: "jpeg", width: null, height: null };
  }
  return null;
}

// スタンプ画像: PNG・GIF・WebP のみ。縦横とも 16〜512px、1MB以下
export function checkStampImage(buf: Buffer): string | null {
  if (buf.length > STAMP_MAX_BYTES) return "スタンプ画像は1枚1MB以下にしてください。";
  const image = sniffImage(buf);
  if (!image || image.type === "jpeg") return "スタンプ画像は PNG・GIF・WebP のファイルにしてください。";
  if (image.width === null || image.height === null) return "スタンプ画像の大きさを読み取れませんでした。";
  if (image.width > STAMP_MAX_SIDE || image.height > STAMP_MAX_SIDE) return `スタンプ画像は縦横とも ${STAMP_MAX_SIDE}px 以下にしてください。`;
  if (image.width < STAMP_MIN_SIDE || image.height < STAMP_MIN_SIDE) return `スタンプ画像は縦横とも ${STAMP_MIN_SIDE}px 以上にしてください。`;
  return null;
}

// サムネイル: PNG・GIF・WebP・JPEG。2MB以下
export function checkThumbImage(buf: Buffer): string | null {
  if (buf.length > THUMB_MAX_BYTES) return "サムネイルは2MB以下にしてください。";
  const image = sniffImage(buf);
  if (!image) return "サムネイルは PNG・JPEG・GIF・WebP の画像にしてください。";
  return null;
}

// ---------- 文字 ----------

const URL_PATTERN = /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|jp|io|app|xyz|top|info|biz)\b)/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// 電話番号らしい並び（ハイフンあり・なし、全角数字も含む）
const PHONE_PATTERN = /(0[0-9０-９]{1,4}[-－ー][0-9０-９]{1,4}[-－ー][0-9０-９]{3,4})|(0[789]0[0-9０-９]{8})/;

// 公開してよい文字列か。問題があれば理由を返す（外部への誘導・連絡先・禁止語を止める）
export function checkText(text: string, label: string): string | null {
  if (URL_PATTERN.test(text)) return `${label}にURLは書けません。`;
  if (EMAIL_PATTERN.test(text)) return `${label}にメールアドレスは書けません。`;
  if (PHONE_PATTERN.test(text)) return `${label}に電話番号は書けません。`;
  const lower = text.toLowerCase();
  if (BLOCKED_WORDS.some((word) => lower.includes(word))) return `${label}に不適切な言葉が含まれています。`;
  return null;
}

// ---------- 作品ごとの中身 ----------

const HEX = /^#[0-9a-fA-F]{6}$/;

export type ThemePayload = { mine: string; bg: string; accent: string };
export type QuizQuestionPayload = { q: string; options: string[]; answer: number };
export type QuizPayload = { questions: QuizQuestionPayload[] };
export const TONES = ["やさしい", "ていねい", "ふつう", "カジュアル"] as const;
export const LENGTHS = ["短め", "ふつう", "詳しめ"] as const;
export type AiStylePayload = { tone: (typeof TONES)[number]; length: (typeof LENGTHS)[number]; emoji: boolean };

export function checkTheme(value: unknown): { ok: true; payload: ThemePayload } | { ok: false; error: string } {
  const v = value as Partial<ThemePayload> | null;
  if (!v || typeof v !== "object") return { ok: false, error: "配色を入力してください。" };
  for (const key of ["mine", "bg", "accent"] as const) {
    if (typeof v[key] !== "string" || !HEX.test(v[key] as string)) {
      return { ok: false, error: "配色は「#RRGGBB」の形で入力してください。" };
    }
  }
  return { ok: true, payload: { mine: v.mine as string, bg: v.bg as string, accent: v.accent as string } };
}

export function checkQuiz(value: unknown): { ok: true; payload: QuizPayload } | { ok: false; error: string } {
  const list = (value as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return { ok: false, error: "問題を入力してください。" };
  if (list.length < QUIZ_MIN_QUESTIONS || list.length > QUIZ_MAX_QUESTIONS) {
    return { ok: false, error: `問題は${QUIZ_MIN_QUESTIONS}〜${QUIZ_MAX_QUESTIONS}問にしてください。` };
  }
  const questions: QuizQuestionPayload[] = [];
  for (const [index, raw] of list.entries()) {
    const item = raw as { q?: unknown; options?: unknown; answer?: unknown };
    const no = index + 1;
    if (typeof item.q !== "string" || !item.q.trim() || item.q.length > 100) {
      return { ok: false, error: `${no}問目の問題文は1〜100文字で入力してください。` };
    }
    if (!Array.isArray(item.options) || item.options.length !== 4) {
      return { ok: false, error: `${no}問目の選択肢は4つにしてください。` };
    }
    const options = item.options.map((o) => (typeof o === "string" ? o.trim() : ""));
    if (options.some((o) => !o || o.length > 30)) {
      return { ok: false, error: `${no}問目の選択肢は1〜30文字で入力してください。` };
    }
    if (new Set(options).size !== 4) return { ok: false, error: `${no}問目の選択肢に同じものがあります。` };
    if (typeof item.answer !== "number" || !Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) {
      return { ok: false, error: `${no}問目の正解を選んでください。` };
    }
    const textError = checkText(`${item.q} ${options.join(" ")}`, `${no}問目`);
    if (textError) return { ok: false, error: textError };
    questions.push({ q: item.q.trim(), options, answer: item.answer });
  }
  return { ok: true, payload: { questions } };
}

export function checkAiStyle(value: unknown): { ok: true; payload: AiStylePayload } | { ok: false; error: string } {
  const v = value as Partial<AiStylePayload> | null;
  if (!v || !(TONES as readonly string[]).includes(v.tone as string)) return { ok: false, error: "口調を選んでください。" };
  if (!(LENGTHS as readonly string[]).includes(v.length as string)) return { ok: false, error: "長さを選んでください。" };
  if (typeof v.emoji !== "boolean") return { ok: false, error: "絵文字の使い方を選んでください。" };
  return { ok: true, payload: { tone: v.tone as AiStylePayload["tone"], length: v.length as AiStylePayload["length"], emoji: v.emoji } };
}

// senninai の応答スタイルを、AI への指示の文にする（選択肢だけから作るので、自由文の指示は入らない）
export function aiStyleInstruction(style: AiStylePayload): string {
  const tone =
    style.tone === "やさしい" ? "やさしい口調で" : style.tone === "ていねい" ? "ていねいな言葉づかいで" : style.tone === "カジュアル" ? "くだけた親しみやすい口調で" : "";
  const length = style.length === "短め" ? "短く" : style.length === "詳しめ" ? "少し詳しく" : "";
  const emoji = style.emoji ? "絵文字を適度に使って" : "絵文字は使わずに";
  return `回答は${[tone, length].filter(Boolean).join("、")}、${emoji}答えてください。`;
}

// 価格の確認（10〜1000 の整数）
export function checkPrice(value: unknown): string | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < PRICE_MIN || n > PRICE_MAX) {
    return `価格は${PRICE_MIN}〜${PRICE_MAX}ptの整数で入力してください。`;
  }
  return null;
}

// 作品の名前・説明の検査（空・長さ・禁止の内容）
export function checkBasics(name: unknown, description: unknown): string | null {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40) return "作品の名前は1〜40文字で入力してください。";
  if (typeof description !== "string" || description.length > 300) return "説明は300文字以内にしてください。";
  return checkText(`${name} ${description}`, "作品の名前と説明");
}


// ---------- 拡張機能（HTML・CSS・JavaScript） ----------
// 拡張機能は、SoraChat 本体とは別の sandbox iframe 内で実行する。
// 開発上の制限は減らすが、SoraChat の認証情報・画面・API ブリッジを守る隔離境界は維持する。

export type ExtensionPayload = { html: string; css: string; js: string };

// 親ページの構造・基準 URL・文書ポリシーを変更し得るタグは引き続き禁止する。
// これはコード表現の制限ではなく、SoraChat 本体との隔離を保つための制限。
const EXT_BLOCKED_TAGS = /<\s*(iframe|frame|frameset|object|embed|base|meta|portal|applet)\b/i;

export function checkExtension(value: unknown): { ok: true; payload: ExtensionPayload } | { ok: false; error: string } {
  const v = value as Partial<ExtensionPayload> | null;
  if (!v || typeof v !== "object") return { ok: false, error: "拡張機能のコードを入力してください。" };
  const html = typeof v.html === "string" ? v.html : "";
  const css = typeof v.css === "string" ? v.css : "";
  const js = typeof v.js === "string" ? v.js : "";
  if (!html.trim() && !js.trim()) return { ok: false, error: "HTML か JavaScript のどちらかは入力してください。" };
  const total = html.length + css.length + js.length;
  if (total > EXT_TOTAL_MAX) {
    return { ok: false, error: `コードは HTML・CSS・JavaScript を合わせて ${EXT_TOTAL_MAX.toLocaleString("ja-JP")} 文字までです（今は ${total.toLocaleString("ja-JP")} 文字）。` };
  }
  if (EXT_BLOCKED_TAGS.test(html)) return { ok: false, error: "iframe・frame・object・embed・meta・base など、隔離境界に影響するHTML要素は使えません。" };
  // 外部 URL、外部ライブラリ、fetch 等の通信 API、CSS @import は利用可能。
  // 実際に到達できる通信先は、下の CSP と sandbox によって制御する。
  return { ok: true, payload: { html, css, js } };
}

// 隔離して表示するための HTML 文書を作る。CSP の sandbox は必ず維持する。
// 拡張機能の開発自由度を上げるため、HTTPS の外部リソースと HTTPS/WSS 通信を許可する。
// allow-same-origin・親ページへの権限・フォーム送信・入れ子フレームは許可しない。
export const EXTENSION_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' https: data: blob:",
  "style-src 'unsafe-inline' https: data: blob:",
  "img-src data: blob: https:",
  "media-src data: blob: https:",
  "font-src data: blob: https:",
  "connect-src https: wss:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'"
].join("; ");

// ---------- 拡張機能からのポイント配布・アカウント情報（ブリッジ） ----------
// 枠の中は opaque origin（別の出所）なので、ログインのクッキーは届かず、ソラチャットのAPIを本人として呼べない。
// ポイント配布・アカウント情報は window.sorachat という窓口を使い、ソラチャットの画面へ postMessage で頼む。
// ソラチャットの画面は、頼まれた内容を確かめてからサーバーへ取り次ぐ（配布の上限・利用者の許可はサーバーが確かめる）。
// 下の値は、ブリッジの仕組み・上限・開発者ドキュメント（senninstudio の仕様）の全部で同じものを使う。
export const EXT_BRIDGE = {
  channel: "sorachat-ext",
  version: 3,
  awardMin: 1, // 1回に配れる最小
  awardPerCallDefault: 500, // 1回に配れる量の初期値（管理者が拡張機能ごとに変えられる）
  reasonMax: 40, // 理由の最大文字数
  requestIdMin: 8, // 同じ配布を押し直すための ID（省略すると毎回新しい ID）
  requestIdMax: 64,
  timeoutMs: 20_000,
  // 拡張機能からの支払い（利用者が確認画面で押すまで待つので、長めに待つ）
  chargeMin: 10, // 1回に払う最小（pt）
  chargeMaxDefault: 1000, // 作者が通常の拡張機能の1回に払わせられる最大（pt）
  chargeMaxCertified: 5000, // 認定開発者の拡張機能の1回の最大（pt）。管理者が認定を決める
  chargeTitleMax: 40, // 確認画面に出す品名の最大文字数
  chargeTimeoutMs: 180_000,
  // オンライン対戦：相手が集まるまで待つ時間・招待の返事を待つ時間（長めに待つ）
  battleTimeoutMs: 600_000
} as const;

// 枠の中で動くブリッジ。ユーザーのコードより先に読み込む。
function extensionBridgeScript(): string {
  const config = JSON.stringify({
    channel: EXT_BRIDGE.channel,
    timeoutMs: EXT_BRIDGE.timeoutMs,
    chargeTimeoutMs: EXT_BRIDGE.chargeTimeoutMs,
    battleTimeoutMs: EXT_BRIDGE.battleTimeoutMs
  });
  return `(function () {
  var CONFIG = ${config};
  var pending = Object.create(null);
  var battleListeners = [];
  var seq = 0;
  function newId() { seq += 1; return seq + "-" + Math.random().toString(36).slice(2, 10); }
  function call(type, data, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = newId();
      var timer = setTimeout(function () {
        delete pending[id];
        var e = new Error("ソラチャットからの応答がありませんでした。");
        e.code = "timeout";
        reject(e);
      }, timeoutMs || CONFIG.timeoutMs);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.parent.postMessage({ channel: CONFIG.channel, id: id, type: type, data: data || {} }, "*");
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    // 対戦の知らせ（相手の動き・誰かが抜けた・終わった）は、登録された関数へ渡す
    if (msg && msg.channel === CONFIG.channel && msg.event === "battle") {
      battleListeners.forEach(function (fn) {
        try { fn(msg.payload); } catch (e) {}
      });
      return;
    }
    if (!msg || msg.channel !== CONFIG.channel || !pending[msg.id]) return;
    var p = pending[msg.id];
    delete pending[msg.id];
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg.data);
    } else {
      var e = new Error(msg.error || "失敗しました。");
      e.code = msg.code || "error";
      e.data = msg.data || {};
      p.reject(e);
    }
  });
  window.sorachat = {
    version: ${EXT_BRIDGE.version},
    getAccount: function () { return call("account"); },
    requestAccess: function () { return call("consent"); },
    awardPoints: function (amount, reason, requestId) {
      return call("award", {
        amount: amount,
        reason: reason || "",
        requestId: requestId || (Date.now().toString(36) + "-" + newId())
      });
    },
    charge: function (amount, title, requestId) {
      return call("charge", {
        amount: amount,
        title: title || "",
        requestId: requestId || (Date.now().toString(36) + "-" + newId())
      }, CONFIG.chargeTimeoutMs);
    },
    storage: {
      get: function (key) {
        return call("storage-get", { key: key }).then(function (d) { return d.value === undefined ? null : d.value; });
      },
      set: function (key, value) { return call("storage-set", { key: key, value: value }); },
      remove: function (key) { return call("storage-remove", { key: key }); },
      keys: function () {
        return call("storage-keys").then(function (d) { return d.keys || []; });
      }
    },
    battle: {
      subscription: function () { return call("battle-status"); },
      findMatch: function (size) { return call("battle-find", { size: size || 2 }, CONFIG.battleTimeoutMs); },
      inviteFriends: function () { return call("battle-invite", {}, CONFIG.battleTimeoutMs); },
      cancel: function () { return call("battle-cancel"); },
      send: function (payload) { return call("battle-send", { payload: payload }); },
      leave: function () { return call("battle-leave"); },
      onEvent: function (fn) { if (typeof fn === "function") battleListeners.push(fn); }
    }
  };
})();`;
}

export function buildExtensionDocument(payload: Partial<ExtensionPayload>): string {
  const html = payload.html ?? "";
  const css = (payload.css ?? "").replace(/<\/style/gi, "<\\/style");
  const js = (payload.js ?? "").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;min-height:100%;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;color:#111;background:#fff}*{box-sizing:border-box}</style>
<style>${css}</style>
</head>
<body>
${html}
<script>
window.addEventListener("error", function (event) {
  var box = document.createElement("pre");
  box.setAttribute("style", "color:#b00020;white-space:pre-wrap;padding:12px;margin:0");
  box.textContent = String((event && event.message) || "エラーが起きました");
  document.body.appendChild(box);
});
</script>
<script>
${extensionBridgeScript()}
</script>
<script>
${js}
</script>
</body>
</html>`;
}
