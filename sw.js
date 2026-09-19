const CACHE = "ace-register-supabase-v1";
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.js", "./supabase-config.js",
  "./manifest.json", "./icon-192.png", "./icon-512.png", "./logo-small.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for the app shell (so updates show immediately when
// online), falling back to cache when offline. Supabase API calls
// (different origin) are never intercepted here — they pass straight
// through to the network, and the app's own IndexedDB queue handles
// the case where that fails.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // let Supabase requests go straight through

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match("./index.html")))
  );
});

// Shows a real notification even when the app is fully closed. The
// Edge Function sends a JSON payload like {title, body, url}.
self.addEventListener("push", (e) => {
  let data = { title: "ACE Register", body: "You have an update." };
  try { data = e.data.json(); } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || "ACE Register", {
      body: data.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      data: { url: data.url || "./" },
    })
  );
});

// Tapping the notification opens the app (or focuses it if already open).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) { if ("focus" in client) return client.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
