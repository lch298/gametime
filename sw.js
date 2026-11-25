// Lets phones install Gamtime as an app. It doesn't save anything offline,
// so a new upload to Netlify always shows up right away.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // scores, Google, images: untouched
  e.respondWith(fetch(e.request));
});
