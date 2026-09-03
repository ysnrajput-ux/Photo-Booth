// Minimal service worker.
// Its only job right now is to EXIST — Android's "install app" / TWA
// (Trusted Web Activity) tooling requires a registered service worker
// before it will treat this site as an installable app. It does not
// cache or intercept anything, so it can never make the live photobooth
// / camera / websocket features show stale or broken data.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

// Pass every request straight through to the network — no caching.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
