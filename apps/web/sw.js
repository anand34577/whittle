/*
 * Offline support for the web app. The build writes this file out with BUILD
 * (its version and every file it made) in front, so each build is a new worker.
 * Installing keeps a copy of those files, so Whittle opens and works without a network. A new build installs alongside; the app offers a
 * reload, and the old copy is removed once the new one takes over.
 * Designs, accounts and the API are never cached here.
 */
/* global BUILD */
const OWN = `whittle-${BUILD.version}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(OWN);
      await cache.addAll(BUILD.files.map((f) => new Request(f, { cache: "reload" })));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  // This worker's own build, not a shared note: a newer build installing meanwhile must not make it delete its own files.
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== OWN) await caches.delete(key);
  })());
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
  // Built files have content hashes in their names, so a kept copy is always right whatever the query.
  // Other files (the manifest, icons) are matched with their query, so a versioned query does fetch anew (audit X-6).
  const hashed = new URL(req.url).pathname.includes("/assets/");
  event.respondWith(caches.match(req, { ignoreSearch: hashed }).then((hit) => hit ?? fetch(req)));
});
