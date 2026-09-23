// App-shell service worker: network-first with cache fallback so the PWA
// opens instantly (and offline shows the last shell). API and photo requests
// always go to the network.
const CACHE = 'reef-shell-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/photos') || url.pathname.startsWith('/alexa')) return
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(event.request)
        if (res.ok) cache.put(event.request, res.clone())
        return res
      } catch {
        const hit = await cache.match(event.request, { ignoreSearch: url.pathname === '/' })
        return hit ?? Response.error()
      }
    })
  )
})
