/*
 * Offline support for the web app. The build writes this file out with BUILD
 * (its version and every file it made) in front, so each build is a new worker.
 * Installing keeps a copy of those files, so Whittle opens and works without a network. A new build installs alongside; the app offers a
 * reload, and the old copy is removed once the new one takes over.
 * Designs, accounts and the API are never cached here.
 */
/* global BUILD */
const META = "whittle-meta";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const { version, files } = BUILD;
      const cache = await caches.open(`whittle-${version}`);
      await cache.addAll(files.map((f) => new Request(f, { cache: "reload" })));
      await (await caches.open(META)).put("./version", new Response(version));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const version = await (await (await caches.open(META)).match("./version"))?.text();
      for (const key of await caches.keys()) if (key !== META && key !== `whittle-${version}`) await caches.delete(key);
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "update") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  if (req.mode === "navigate") {
    // The page itself: fresh when online, the kept copy when not.
    event.respondWith(fetch(req).catch(async () => (await caches.match("./")) ?? (await caches.match("./index.html")) ?? Response.error()));
    return;
  }
  // Built files have content hashes in their names, so a kept copy is always right.
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit ?? fetch(req)));
});
