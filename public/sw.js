// One-shot kill-switch for any service worker installed by a prior deploy.
// The current app intentionally has no SW; if one is registered, evict it
// and clear all caches so the next page load fetches everything fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch {}
      try {
        await self.registration.unregister();
      } catch {}
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((c) => c.navigate(c.url));
      } catch {}
    })()
  );
});
