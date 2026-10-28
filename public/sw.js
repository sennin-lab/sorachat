self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = { body: event.data ? event.data.text() : "" };
    }
    await self.registration.showNotification(data.title || "SoraChat", {
      body: data.body || "",
      tag: data.tag,
      renotify: false,
      icon: "/icons/icon-180.png",
      data: { url: data.url || "/" }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.navigate(url).catch(() => undefined);
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
