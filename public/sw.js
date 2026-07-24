// Retire the earlier offline worker. Configuration and connection behavior must
// always come from the currently running server image; caching an old client
// bundle can make a rebuilt bridge receive obsolete connection fields.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("flexidim-web-"))
        .map((key) => caches.delete(key)),
    );
    const windows = await self.clients.matchAll({ type: "window" });
    await self.registration.unregister();
    await Promise.all(
      windows.map((client) => client.navigate(client.url).catch(() => undefined)),
    );
  })());
});
