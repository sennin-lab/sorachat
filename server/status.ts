import { config } from "./config.js";
import { pushEnabled } from "./push.js";
import { IMAGE_BUCKET, sb } from "./supabase.js";
import { tursoExecute } from "./turso.js";

// サービス稼働状況（/api/status と /status の画面）。
// 表示する値はすべて、このサーバーが実際に行った確認の結果です。固定の文言で「正常」とは出しません。
//  - ok           : 問い合わせに成功した
//  - degraded     : 応答はあるがエラーが返った、または任意の部品が使えない
//  - down         : 問い合わせに失敗した（時間切れを含む）
//  - unconfigured : 必要な設定（環境変数）がないため使えない
//  - unchecked    : 設定の有無は分かるが、この確認では実際の接続を測っていない
//  - maintenance  : メンテナンスモード中

export type State = "ok" | "degraded" | "down" | "unconfigured" | "unchecked" | "maintenance";

export type Check = {
  label: string;
  state: State;
  latencyMs: number | null;
  detail: string;
  optional: boolean;
};

type ProbeResult = { state: State; latencyMs: number | null; detail: string };
type Probe = { label: string; run: () => Promise<ProbeResult> };

export type Feature = {
  id: string;
  group: string;
  name: string;
  state: State;
  note: string | null;
  checks: Check[];
};

export type StatusReport = {
  service: "SoraChat";
  checkedAt: string;
  cacheSeconds: number;
  uptimeSeconds: number;
  maintenance: { enabled: boolean; message: string };
  overall: "ok" | "degraded" | "down" | "maintenance";
  features: Feature[];
};

const TIMEOUT_MS = 5000;
const CACHE_MS = 30_000;
const startedAt = Date.now();

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError("timeout")), TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// 中身の問い合わせが成功したら ok、失敗したら down
async function timedCheck(work: () => Promise<void>, okDetail: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    await withTimeout(work());
    return { state: "ok", latencyMs: Date.now() - started, detail: okDetail };
  } catch (error) {
    return {
      state: "down",
      latencyMs: null,
      detail: error instanceof TimeoutError ? `${TIMEOUT_MS / 1000}秒以内に応答がありませんでした` : "問い合わせに失敗しました"
    };
  }
}

// 外部のURLに接続できるか。応答が返れば接続できた（中身までは見ない）。5xx は degraded
async function httpCheck(url: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    const latencyMs = Date.now() - started;
    if (res.status >= 500) return { state: "degraded", latencyMs, detail: `エラーが返りました（HTTP ${res.status}）` };
    return { state: "ok", latencyMs, detail: `応答がありました（HTTP ${res.status}）` };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      state: "down",
      latencyMs: null,
      detail: timedOut ? `${TIMEOUT_MS / 1000}秒以内に応答がありませんでした` : "接続できませんでした"
    };
  }
}

const tableCheck = (table: string): (() => Promise<ProbeResult>) =>
  () =>
    timedCheck(async () => {
      const { error } = await sb.from(table).select("*", { head: true }).limit(1);
      if (error) throw error;
    }, "問い合わせに成功しました");

const TABLE_NAMES: Record<string, string> = {
  sc_users: "ユーザー情報",
  sc_sessions: "ログインのセッション",
  sc_notes: "ノート",
  sc_friends: "友だち",
  sc_friend_requests: "友だちの申請",
  sc_blocks: "ブロック",
  sc_conversations: "トーク",
  sc_members: "トークのメンバー",
  sc_messages: "メッセージ",
  sc_reactions: "リアクション",
  sc_poll_votes: "投票",
  sc_games: "ミニゲーム",
  sc_user_stamps: "スタンプ",
  sc_senninai_pending: "senninai の送信確認",
  sc_push_subscriptions: "通知の登録"
};

const PROBES: Record<string, Probe> = {
  server: {
    label: "Webアプリ本体",
    run: async () => ({
      state: "ok",
      latencyMs: null,
      detail: `応答しています（起動から ${Math.floor((Date.now() - startedAt) / 1000)} 秒）`
    })
  },
  blob: {
    label: "画像・ファイルの保存先（Turso）",
    run: () =>
      timedCheck(async () => {
        await tursoExecute("select 1");
      }, "問い合わせに成功しました")
  },
  storage: {
    label: "旧画像の保存先（Supabase Storage）",
    run: () =>
      timedCheck(async () => {
        const { error } = await sb.storage.from(IMAGE_BUCKET).list("", { limit: 1 });
        if (error) throw error;
      }, "問い合わせに成功しました")
  },
  sennin: {
    label: "仙人アカウントの認証サーバー",
    run: async () => {
      const { clientId, authorizationUrl } = config.sennin;
      if (!clientId || !authorizationUrl) {
        return { state: "unconfigured", latencyMs: null, detail: "設定（環境変数）が未設定です" };
      }
      return httpCheck(authorizationUrl);
    }
  },
  senninai: {
    label: "senninai の接続先（UserLocal）",
    run: () => httpCheck(`${config.senninAi.baseUrl}/`)
  },
  "cfg:push": {
    label: "通知の鍵（VAPID）",
    run: async () =>
      pushEnabled
        ? { state: "unchecked", latencyMs: null, detail: "鍵は設定されています（配信のテストはしていません）" }
        : { state: "unconfigured", latencyMs: null, detail: "鍵が未設定のため、通知は送れません" }
  },
  "cfg:admin": {
    label: "管理者パスワード",
    run: async () =>
      config.adminPassword
        ? { state: "unchecked", latencyMs: null, detail: "設定されています（ログインはこの確認では試していません）" }
        : { state: "unconfigured", latencyMs: null, detail: "未設定のため、管理者ログインは使えません" }
  },
  realtime: {
    label: "リアルタイム接続（WebSocket・Supabase Realtime）",
    run: async () => ({ state: "unchecked", latencyMs: null, detail: "この確認では接続テストをしていません" })
  },
  ...Object.fromEntries(
    Object.entries(TABLE_NAMES).map(([table, name]) => [
      `table:${table}`,
      { label: `データベース：${name}（${table}）`, run: tableCheck(table) }
    ])
  ) as Record<string, Probe>
};

type FeatureDef = {
  id: string;
  group: string;
  name: string;
  needs: string[];
  optional?: string[];
  note?: string;
};

const FEATURES: FeatureDef[] = [
  { id: "server", group: "基盤", name: "サーバー（Webアプリ本体）", needs: ["server"] },
  { id: "storage-blob", group: "基盤", name: "画像・ファイルの保存", needs: ["blob"] },
  { id: "storage-legacy", group: "基盤", name: "移行前の画像の読み込み", needs: ["storage"] },
  { id: "login", group: "アカウント", name: "ユーザー名・パスワードでログイン・新規登録", needs: ["table:sc_users", "table:sc_sessions"] },
  { id: "login-sennin", group: "アカウント", name: "仙人アカウントでログイン", needs: ["sennin", "table:sc_sessions", "table:sc_users"] },
  { id: "profile", group: "アカウント", name: "プロフィール・ノート・アバター", needs: ["table:sc_users", "table:sc_notes", "blob"], optional: ["storage"] },
  { id: "friends", group: "友だち", name: "友だち（追加・申請・削除）", needs: ["table:sc_friends", "table:sc_friend_requests", "table:sc_users"] },
  { id: "blocks", group: "友だち", name: "ブロック", needs: ["table:sc_blocks"] },
  { id: "talk-dm", group: "トーク", name: "トーク（1対1）", needs: ["table:sc_conversations", "table:sc_members", "table:sc_messages"] },
  { id: "talk-group", group: "トーク", name: "グループ（作成・メンバー・名前変更）", needs: ["table:sc_conversations", "table:sc_members", "table:sc_messages"] },
  { id: "openchat", group: "トーク", name: "オープンチャット", needs: ["table:sc_conversations", "table:sc_members"] },
  { id: "message-edit", group: "トーク", name: "返信・編集・送信の取り消し・転送", needs: ["table:sc_messages"] },
  { id: "reactions", group: "トーク", name: "リアクション", needs: ["table:sc_reactions", "table:sc_messages"] },
  { id: "media", group: "トーク", name: "画像・ファイル・連絡先の送信", needs: ["table:sc_messages", "blob"], optional: ["storage"] },
  { id: "polls", group: "トーク", name: "投票", needs: ["table:sc_messages", "table:sc_poll_votes"] },
  { id: "stamps", group: "トーク", name: "スタンプ", needs: ["table:sc_messages", "table:sc_user_stamps"] },
  { id: "realtime", group: "トーク", name: "新着・既読などのリアルタイム反映", needs: ["realtime"] },
  { id: "push", group: "通知", name: "Web Push 通知", needs: ["cfg:push", "table:sc_push_subscriptions"] },
  { id: "senninai", group: "AI・ゲーム", name: "senninai（AIチャット）", needs: ["senninai", "table:sc_senninai_pending"] },
  {
    id: "quiz",
    group: "AI・ゲーム",
    name: "ミニゲーム（早押しクイズ）",
    needs: ["table:sc_games"],
    optional: ["senninai"],
    note: "senninai が応答しないときは、固定の問題で続けます"
  },
  { id: "admin", group: "管理", name: "管理者パネル", needs: ["cfg:admin", "table:sc_users"] }
];

let cached: { at: number; report: StatusReport } | null = null;
let inFlight: Promise<StatusReport> | null = null;

async function runProbe(key: string): Promise<ProbeResult> {
  const probe = PROBES[key];
  if (!probe) return { state: "down", latencyMs: null, detail: "この確認は定義されていません" };
  try {
    return await probe.run();
  } catch {
    return { state: "down", latencyMs: null, detail: "確認中にエラーが起きました" };
  }
}

async function buildReport(): Promise<StatusReport> {
  const keys = [...new Set(FEATURES.flatMap((f) => [...f.needs, ...(f.optional ?? [])]))];
  const probes = new Map<string, ProbeResult>();
  await Promise.all(keys.map(async (key) => probes.set(key, await runProbe(key))));

  const maintenance = config.maintenance.enabled;
  const toCheck = (key: string, optional: boolean): Check => {
    const result = probes.get(key) ?? { state: "down" as State, latencyMs: null, detail: "確認できませんでした" };
    return { label: PROBES[key]?.label ?? key, optional, ...result };
  };

  const features: Feature[] = FEATURES.map((def) => {
    const needs = def.needs.map((key) => toCheck(key, false));
    const optional = (def.optional ?? []).map((key) => toCheck(key, true));
    const checks = [...needs, ...optional];

    let state: State;
    if (maintenance) state = "maintenance";
    else if (needs.some((c) => c.state === "down")) state = "down";
    else if (needs.some((c) => c.state === "unconfigured")) state = "unconfigured";
    else if (needs.some((c) => c.state === "degraded") || optional.some((c) => c.state !== "ok" && c.state !== "unchecked")) state = "degraded";
    else if (checks.some((c) => c.state === "unchecked")) state = "unchecked";
    else state = "ok";

    return { id: def.id, group: def.group, name: def.name, state, note: def.note ?? null, checks };
  });

  const overall = maintenance
    ? "maintenance"
    : features.some((f) => f.state === "down")
      ? "down"
      : features.some((f) => f.state === "degraded" || f.state === "unconfigured")
        ? "degraded"
        : "ok";

  return {
    service: "SoraChat",
    checkedAt: new Date().toISOString(),
    cacheSeconds: CACHE_MS / 1000,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    maintenance: { enabled: maintenance, message: config.maintenance.message },
    overall,
    features
  };
}

// 30秒のあいだは同じ結果を返す（外部サービスへの問い合わせを増やさないため）
export async function getStatus(): Promise<StatusReport> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  if (!inFlight) {
    inFlight = buildReport()
      .then((report) => {
        cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
