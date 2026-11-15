/* 驭潮 PWA：只为「像 App 一样启动」服务，不做数据缓存。
 * - 导航请求：网络优先（后端 index.html 本就 no-cache），断网回退到最近一次外壳
 * - /assets/*：带 hash，缓存优先
 * - /api/* 与其它请求：完全不接管
 */
const CACHE = "yuchao-shell-v1";
const SHELL = "/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const resp = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(SHELL, resp.clone());
        return resp;
      } catch {
        const hit = await caches.match(SHELL);
        return hit || new Response("网络不可用，请恢复网络后重试。", {
          status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const resp = await fetch(req);
      if (resp.ok) (await caches.open(CACHE)).put(req, resp.clone());
      return resp;
    })());
  }
});
