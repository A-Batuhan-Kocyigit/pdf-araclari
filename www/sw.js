// PDF Araçları — service worker: internetsiz çalışma + paylaşım hedefi
const VERSION = "v2";
const CACHE = `pdf-araclari-${VERSION}`;
const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/app.js",
  "js/pdfcore.js",
  "js/themes.js",
  "vendor/pdf-lib.min.js",
  "vendor/fontkit.umd.min.js",
  "vendor/pdf.min.mjs",
  "vendor/pdf.worker.min.mjs",
  "fonts/DejaVuSans-Bold.ttf",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("pdf-araclari-v") && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Android "Paylaş" menüsünden gelen PDF'ler (manifest share_target)
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const c = await caches.open("pdf-araclari-shared");
      let i = 0;
      for (const f of form.getAll("pdf")) {
        if (!(f instanceof File)) continue;
        const name = f.name || `paylasilan_${i + 1}.pdf`;
        await c.put(`shared/${Date.now()}_${i++}`, new Response(f, { headers: { "x-name": encodeURIComponent(name) } }));
      }
      return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
    })());
    return;
  }

  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Önbellekten hemen ver, arka planda güncelle (stale-while-revalidate)
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => {
      if (res.ok && res.type === "basic") c.put(e.request, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response("Çevrimdışı", { status: 503 });
  })());
});
