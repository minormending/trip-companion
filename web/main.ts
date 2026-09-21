import { EntityCache } from '../src/cache/entityCache.ts'
import { LocalStorageStore } from '../src/cache/webStore.ts'
import { DeterministicProvider } from '../src/content/providers/deterministic.ts'
import type { Refusal } from '../src/content/generate.ts'
import type { Trip } from '../src/domain/types.ts'
import { PhotonGeocoder } from '../src/geo/geocode.ts'
import { runPipeline } from '../src/pipeline.ts'
import { renderBriefing } from '../src/render/briefing.ts'
import { OsrmProvider } from '../src/routing/osrm.ts'
import { NullTransitProvider } from '../src/routing/transit.ts'
import { decodeTrip, encodeTrip } from './share.ts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const form = $<HTMLFormElement>('form')
const output = $<HTMLDivElement>('output')
const status = $<HTMLParagraphElement>('status')
const intro = $<HTMLDivElement>('intro')
const actions = $<HTMLDivElement>('actions')
const shareBtn = $<HTMLButtonElement>('share')
const printBtn = $<HTMLButtonElement>('print')
const restartBtn = $<HTMLButtonElement>('restart')

let cache: EntityCache | null = null

function setStatus(text: string): void {
  status.textContent = text
  status.hidden = text === ''
}

/**
 * The renderer emits a whole document because the CLI writes files. In the
 * browser only the body content is wanted, and the stylesheet is already in
 * the page, so the briefing is extracted rather than re-templated.
 */
function mountBriefing(html: string): void {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const wrap = doc.querySelector('.wrap')
  output.replaceChildren()
  if (wrap) output.append(...Array.from(wrap.childNodes).map((n) => document.importNode(n, true)))
  intro.hidden = true
  actions.hidden = false
  output.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function show(trip: Trip, refusals: Refusal[], interactive: boolean): void {
  mountBriefing(renderBriefing(trip, { refusals, interactive }))
}

async function build(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const data = new FormData(form)
  const text = String(data.get('text') ?? '').trim()
  if (!text) {
    setStatus('Paste an itinerary first.')
    return
  }

  form.querySelectorAll('button, textarea, input').forEach((el) => {
    ;(el as HTMLInputElement).disabled = true
  })
  setStatus('Starting…')

  try {
    cache ??= await EntityCache.open(new LocalStorageStore())
    const title = String(data.get('title') ?? '').trim()
    const departs = String(data.get('departs') ?? '').trim()

    const result = await runPipeline(
      text,
      {
        geocoder: new PhotonGeocoder({ minIntervalMs: 1100 }),
        routers: [new OsrmProvider(), new NullTransitProvider()],
        providers: [new DeterministicProvider()],
        cache,
      },
      {
        ...(title ? { title } : {}),
        ...(departs ? { departsOn: departs } : {}),
        onProgress: (stage, done, total) => {
          setStatus(total > 1 ? `${stage} (${done + 1} of ${total})` : stage)
        },
      },
    )
    await cache.flush()

    const { build: b, fill: f, content: c } = result.reports
    const notes = [
      `${b.resolved} stops`,
      b.unresolved.length ? `${b.unresolved.length} not found` : '',
      b.needsConfirmation.length ? `${b.needsConfirmation.length} need confirming` : '',
      `${f.routed + f.walkFallback} legs routed`,
      c.refusals.length ? `${c.refusals.length} cards unconfirmed` : '',
    ].filter(Boolean)
    setStatus(notes.join(' · '))

    show(result.trip, c.refusals, true)
    history.replaceState(null, '', `#t=${await encodeTrip(result.trip)}`)
  } catch (err) {
    setStatus(`Could not build the briefing: ${(err as Error).message}`)
  } finally {
    form.querySelectorAll('button, textarea, input').forEach((el) => {
      ;(el as HTMLInputElement).disabled = false
    })
  }
}

async function restoreFromHash(): Promise<boolean> {
  const match = /[#&]t=([^&]+)/.exec(location.hash)
  if (!match?.[1]) return false
  setStatus('Opening a shared briefing…')
  const trip = await decodeTrip(match[1])
  if (!trip) {
    setStatus('That shared link could not be read.')
    return false
  }
  // A shared briefing is somebody else's record, so the flag and regenerate
  // controls are withheld: corrections belong to the traveller who was there.
  show(trip, [], false)
  setStatus('Shared briefing — read only.')
  return true
}

form.addEventListener('submit', (e) => void build(e))

output.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const cardId = target.getAttribute('data-flag')
  if (!cardId) return
  target.textContent = 'Flagged, thank you'
  ;(target as HTMLButtonElement).disabled = true
  void cache?.flush()
})

shareBtn.addEventListener('click', () => {
  void navigator.clipboard.writeText(location.href).then(
    () => {
      shareBtn.textContent = 'Link copied'
      setTimeout(() => (shareBtn.textContent = 'Copy share link'), 2000)
    },
    () => setStatus('Could not copy — the link is in the address bar.'),
  )
})

printBtn.addEventListener('click', () => window.print())

restartBtn.addEventListener('click', () => {
  history.replaceState(null, '', location.pathname)
  output.replaceChildren()
  intro.hidden = false
  actions.hidden = true
  setStatus('')
})

void restoreFromHash()
