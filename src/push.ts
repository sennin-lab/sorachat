import { ApiError, api, post } from "./api";
import { setPushEndpoint } from "./realtime";

const toBytes = (base64Url: string) => {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64Url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

export type PushResult = { ok: boolean; message: string };

const UNSUPPORTED = "このブラウザでは通知を使えません。ホーム画面に追加してから開いてください。";

const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const isHomeScreenApp = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  ("standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true);

function explainPushError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "ログイン状態を確認できませんでした。いったんログアウトして、再ログインしてください。";
    if (error.status === 404) return "通知APIが見つかりません。サーバーが最新のバージョンか確認してください。";
    if (error.status === 503) return error.message;
    return `通知サーバーとの通信に失敗しました（HTTP ${error.status}）。時間をおいて再試行してください。`;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") return "通知が許可されていません。iPadの設定でSoraChatの通知を許可してください。";
  if (name === "InvalidStateError") return "通知の準備が完了していません。SoraChatを閉じて、ホーム画面から開き直してください。";
  if (name === "AbortError" || name === "NetworkError" || name === "TypeError") return "通知サービスに接続できませんでした。学校のWi-Fiで制限されている可能性があります。別のネットワークでも確認してください。";
  return "通知を登録できませんでした。iPadOS・通知の許可・サーバーのVAPID設定を確認してください。";
}

// 既存の購読が今のVAPID公開鍵で作られたものか（鍵を変えた後は作り直す必要がある）
const sameKey = (subscription: PushSubscription, key: Uint8Array) => {
  const current = subscription.options?.applicationServerKey;
  // 鍵を読めない古いブラウザでは、今の購読をそのまま使う（毎回作り直さないため）
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
};

// 端末の購読を作り（または再利用し）、サーバーに登録する。許可は呼び出し側で済ませておく
async function subscribeWith(publicKey: string) {
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = toBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("/api/push/subscribe", post(subscription.toJSON()));
  setPushEndpoint(subscription.endpoint);
}

export async function enablePush(): Promise<PushResult> {
  if (!supported()) {
    return {
      ok: false,
      message: isHomeScreenApp()
        ? "このiPadでは通知機能を利用できません。iPadOSを更新してから再度お試しください。"
        : "SafariでSoraChatをホーム画面に追加し、追加したアイコンから開いてください。"
    };
  }

  try {
    // iOS は許可の確認を「スイッチを押した直後」にしか出せないため、最初に呼ぶ
    let permission: NotificationPermission;
    if (Notification.permission === "granted") {
      permission = "granted";
    } else if (Notification.permission === "denied") {
      return { ok: false, message: "通知がブロックされています。iPadの「設定」からSoraChatの通知を許可してから、もう一度お試しください。" };
    } else {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      return { ok: false, message: "通知が許可されませんでした。iPadの設定で通知を許可してください。" };
    }

    const { enabled, publicKey } = await api<{ enabled: boolean; publicKey: string | null }>("/api/push/public-key");
    if (!enabled || !publicKey) return { ok: false, message: "通知サーバーの設定が未完了です。管理者がVAPID_PUBLIC_KEYとVAPID_PRIVATE_KEYを設定する必要があります。" };
    await subscribeWith(publicKey);
    return { ok: true, message: "通知を有効にしました。" };
  } catch (error) {
    return { ok: false, message: explainPushError(error) };
  }
}

// 起動のたびに、許可済みの端末だけ購読を確かめ直す（サーバー側で消えていた場合に備える）。確認は表示しない
export async function refreshPush() {
  if (!supported() || Notification.permission !== "granted") return;
  try {
    const { enabled, publicKey } = await api<{ enabled: boolean; publicKey: string | null }>("/api/push/public-key");
    if (enabled && publicKey) await subscribeWith(publicKey);
  } catch {
    return;
  }
}

export async function disablePush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api("/api/push/unsubscribe", post({ endpoint: subscription.endpoint }));
  await subscription.unsubscribe();
  setPushEndpoint(null);
}

// 「テスト通知」: 登録済みの端末すべてに送り、結果を文字で返す
export async function testPush(): Promise<string> {
  try {
    const result = await api<{ registered: number; delivered: number; failedStatuses: (number | null)[] }>("/api/push/test", post());
    if (result.delivered > 0) {
      return `テスト通知を送りました（${result.delivered}台の端末）。届かない場合は端末の通知の設定（集中モードなど）を確認してください。`;
    }
    return `送れませんでした（登録${result.registered}件・理由: ${result.failedStatuses.join(", ") || "不明"}）。`;
  } catch (err) {
    return err instanceof ApiError ? err.message : "テスト通知を送れませんでした。";
  }
}
