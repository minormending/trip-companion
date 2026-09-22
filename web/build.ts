import { buildLabel } from '../src/build.ts'

/** Replaced at build time by scripts/build-web.ts. */
declare const __BUILD_ID__: string

/**
 * Which build is on screen, and a way off it.
 *
 * Two caches sit between a finished deploy and the tab somebody is looking at,
 * and neither yields to a hard refresh. The service worker precaches the shell
 * and answers the navigation itself; GitHub Pages serves the HTML with a
 * ten-minute max-age on top. A deploy can be green and invisible, and an
 * ordinary reload happily serves the same stale document again.
 *
 * So the number is here to be read out when something looks wrong, and
 * clicking it clears the way: caches dropped, worker unregistered, the
 * document itself refetched rather than revalidated. The hashed bundle needs
 * no special handling — once the HTML is current it names a different file,
 * and that file was never cached under this name.
 *
 * `v43` is the forty-third commit, and maps back to exactly one:
 *
 *   git rev-list --reverse HEAD | sed -n '43p'
 */
export function mountBuildTag(host: HTMLElement): void {
  const id = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

  const tag = document.createElement('button')
  tag.type = 'button'
  tag.className = 'build-tag'
  tag.dataset['build'] = id
  tag.title = 'Reload, bypassing the cache'
  tag.setAttribute('aria-label', `Version ${id}. Reload, bypassing the cache.`)
  tag.textContent = buildLabel(id)

  tag.addEventListener('click', () => {
    void refresh(tag)
  })
  host.append(tag)
}

async function refresh(tag: HTMLButtonElement): Promise<void> {
  tag.disabled = true
  tag.textContent = 'updating…'

  try {
    // The worker goes first. While it is registered it answers navigations
    // from its own precache, so clearing the caches underneath it and then
    // reloading would still land on the shell it is holding.
    if ('serviceWorker' in navigator) {
      const workers = await navigator.serviceWorker.getRegistrations()
      await Promise.all(workers.map((worker) => worker.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }

    // The load-bearing line. `cache: 'reload'` skips the HTTP cache on the way
    // out and *replaces* the stored entry with what comes back, so the reload
    // below gets the new document. A plain location.reload() would be served
    // the stale one again, which is the whole problem.
    await fetch(location.href, { cache: 'reload', credentials: 'same-origin' })
  } catch {
    // Private windows, blocked storage and offline all land here. Reloading is
    // still worth doing; it is the half that sometimes works alone.
  }

  location.reload()
}
