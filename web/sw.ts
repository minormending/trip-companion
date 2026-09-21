/// <reference lib="webworker" />
export {}

// `self` is already declared as WorkerGlobalScope by the lib, so it is cast
// once here rather than redeclared.
const sw = self as unknown as ServiceWorkerGlobalScope

/** Replaced at build time with the hashed asset list and a cache name. */
const PRECACHE: string[] = JSON.parse('__PRECACHE__') as string[]
const CACHE = '__CACHE_NAME__'

/**
 * The shell is precached so the app opens with no network at all. Data is not:
 * the entity cache already holds the facts, and caching Photon or Overpass
 * responses here would serve a traveller stale operational data with no way to
 * tell how old it was.
 */
sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => sw.skipWaiting()),
  )
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  )
})

sw.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== sw.location.origin) return

  // A navigation offline gets the cached shell; the app then runs from
  // whatever it has stored locally, which is the whole point of the phase.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE)
        const shell = await cache.match('index.html')
        return shell ?? Response.error()
      }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit
      return fetch(request).then((response) => {
        // Hashed bundles are immutable, so caching one is always safe.
        if (response.ok && /\.[0-9a-f]{8,}\.js$/.test(url.pathname)) {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
