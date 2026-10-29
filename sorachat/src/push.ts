import { api, post } from "./api";

const toBytes = (base64Url: string) => {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64Url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const UNSUPPORTED = "このブラウザでは通知を使えません。ホーム画面に追加してから開いてください。";

// 通知を有効にする。iOSは「ユーザーの操作の直後」に許可を求める必要があるため、
// 最初の await より前に requestPermission を呼ぶ（呼び出し元のボタン操作から同期的に始める）
export function enablePush(): Promise<{ ok: boolean; message: string }> {
  if (!supported()) return Promise.resolve({ ok: false, message: UNSUPPORTED });
  const permissionAsked =
    Notification.permission === "granted" ? Promise.resolve(Notification.permission) : Notification.requestPermission();
  return permissionAsked.then(async (permission) => {
    if (permission !== "granted") {
      return { ok: false, message: "通知が許可されませんでした。iPhoneは「設定 → 通知 → SoraChat」で許可してください。" };
    }
    try {
      await subscribe();
      return { ok: true, message: "通知を有効にしました。" };
    } catch (err) {
      const text = err instanceof Error ? err.message : "";
      return { ok: false, message: text || "通知の登録に失敗しました。通信状態を確認してください。" };
    }
  });
}

async function subscribe() {
  const { enabled, publicKey } = await api<{ enabled: boolean; publicKey: string | null }>("/api/push/public-key");
  if (!enabled || !publicKey) throw new Error("通知は現在利用できません。");
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toBytes(publicKey)
    }));
  await api("/api/push/subscribe", post(subscription.toJSON()));
}

// アプリを開くたびに、許可済みなら購読を確認して登録し直す（iOSでは購読が切れることがあるため）
export function refreshPushSubscription() {
  if (!supported() || Notification.permission !== "granted") return;
  subscribe().catch(() => undefined);
}

export async function disablePush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api("/api/push/unsubscribe", post({ endpoint: subscription.endpoint }));
  await subscription.unsubscribe();
}
