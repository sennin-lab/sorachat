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
  if (!supported()) return { ok: false, message: UNSUPPORTED };

  let stage = "通知の許可確認";
  try {
    // iOS は許可の確認を「スイッチを押した直後」にしか出せないため、どの await より前に呼ぶ
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, message: "通知が許可されませんでした。iPadの設定から通知を許可してください。" };
    }

    stage = "通知設定の取得";
    const { enabled, publicKey } = await api<{ enabled: boolean; publicKey: string | null }>("/api/push/public-key");
    if (!enabled || !publicKey) return { ok: false, message: "サーバーでプッシュ通知が有効になっていません（VAPID公開鍵が未設定の可能性があります）。" };

    stage = "Service Workerの登録";
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    stage = "プッシュ通知の購読";
    const key = toBytes(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

    stage = "通知登録情報のサーバー保存";
    await api("/api/push/subscribe", post(subscription.toJSON()));
    setPushEndpoint(subscription.endpoint);
    return { ok: true, message: "通知を有効にしました。" };
  } catch (err) {
    const detail = err instanceof ApiError
      ? `${err.message}（HTTP ${err.status || "通信不可"}）`
      : err instanceof Error
        ? `${err.name}: ${err.message}`
        : String(err);
    return { ok: false, message: `${stage}に失敗しました。${detail}` };
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
