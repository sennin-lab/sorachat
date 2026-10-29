import { api, post } from "./api";

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
}

export async function enablePush(): Promise<PushResult> {
  if (!supported()) return { ok: false, message: UNSUPPORTED };
  // iOS は許可の確認を「スイッチを押した直後」にしか出せないため、どの await より前に呼ぶ
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, message: "通知が許可されませんでした。端末の設定から許可してください。" };
  }
  const { enabled, publicKey } = await api<{ enabled: boolean; publicKey: string | null }>("/api/push/public-key");
  if (!enabled || !publicKey) return { ok: false, message: "通知は現在利用できません。" };
  await subscribeWith(publicKey);
  return { ok: true, message: "通知を有効にしました。" };
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
}
