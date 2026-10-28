import { api, post } from "./api";

const toBytes = (base64Url: string) => {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64Url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

export async function enablePush(): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "このブラウザでは通知を使えません。ホーム画面に追加してから開いてください。";
  }
  const { enabled, publicKey } = await api<{ enabled: boolean; publicKey: string | null }>("/api/push/public-key");
  if (!enabled || !publicKey) return "通知は現在利用できません。";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "通知が許可されませんでした。";
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toBytes(publicKey)
    }));
  await api("/api/push/subscribe", post(subscription.toJSON()));
  return "通知を有効にしました。";
}

export async function disablePush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api("/api/push/unsubscribe", post({ endpoint: subscription.endpoint }));
  await subscription.unsubscribe();
}
