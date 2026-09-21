import { EntityCache } from '../src/cache/entityCache.ts'
import { LocalStorageStore } from '../src/cache/webStore.ts'
import { DeterministicProvider } from '../src/content/providers/deterministic.ts'
import { OverpassProvider } from '../src/content/providers/overpass.ts'
import { WikipediaProvider } from '../src/content/providers/wikipedia.ts'
import type { Refusal } from '../src/content/generate.ts'
import type { Trip } from '../src/domain/types.ts'
import { haversineKm, PhotonGeocoder, type GeocodeCandidate } from '../src/geo/geocode.ts'
import type { PendingConfirmation } from '../src/import/build.ts'
import { applyChoices, enrichTrip, resolveTrip, type PipelineDeps } from '../src/pipeline.ts'
import { renderBriefing } from '../src/render/briefing.ts'
import { OsrmProvider } from '../src/routing/osrm.ts'
import { NullTransitProvider } from '../src/routing/transit.ts'
import { decodeTrip, encodeTrip } from './share.ts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const form = $<HTMLFormElement>('form')
const output = $<HTMLDivElement>('output')
const status = $<HTMLParagraphElement>('status')
const intro = $<HTMLDivElement>('intro')
const confirm = $<HTMLDivElement>('confirm')
const actions = $<HTMLDivElement>('actions')
const shareBtn = $<HTMLButtonElement>('share')
const printBtn = $<HTMLButtonElement>('print')
const restartBtn = $<HTMLButtonElement>('restart')

let cache: EntityCache | null = null

function setStatus(text: string): void {
  status.textContent = text
  status.hidden = text === ''
}

function setFormDisabled(disabled: boolean): void {
  form.querySelectorAll('button, textarea, input').forEach((el) => {
    ;(el as HTMLInputElement).disabled = disabled
  })
}

function deps(): PipelineDeps {
  return {
    geocoder: new PhotonGeocoder({ minIntervalMs: 1100 }),
    routers: [new OsrmProvider(), new NullTransitProvider()],
    // Sourced providers first: a recorded fact always beats generic guidance.
    providers: [new OverpassProvider(), new WikipediaProvider(), new DeterministicProvider()],
    ...(cache ? { cache } : {}),
  }
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
  confirm.hidden = true
  actions.hidden = false
  output.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function show(trip: Trip, refusals: Refusal[], interactive: boolean): void {
  mountBriefing(renderBriefing(trip, { refusals, interactive }))
}

function describe(candidate: GeocodeCandidate, relativeTo: GeocodeCandidate): string {
  const km = haversineKm(candidate.coords, relativeTo.coords)
  if (km < 0.05) return candidate.label ?? ''
  const away = km < 1 ? `${Math.round(km * 1000)} m away` : `${km.toFixed(1)} km away`
  return [candidate.label, away].filter(Boolean).join(' · ')
}

/**
 * Asking is cheap; enriching the wrong building is not. Roughly a third of
 * places on a real itinerary land here, so this is a normal step in the flow
 * rather than an error state.
 */
function askToConfirm(pending: PendingConfirmation[]): Promise<Array<{ placeId: string; candidate: GeocodeCandidate }>> {
  return new Promise((resolve) => {
    confirm.replaceChildren()

    const heading = document.createElement('h2')
    heading.textContent = pending.length === 1 ? 'One place needs confirming' : `${pending.length} places need confirming`
    const lead = document.createElement('p')
    lead.className = 'sub'
    lead.textContent =
      'These names matched more than one nearby place. Picking the right one now avoids building the rest of the briefing around the wrong spot.'
    confirm.append(heading, lead)

    for (const item of pending) {
      const box = document.createElement('div')
      box.className = 'choice'

      const label = document.createElement('p')
      const strong = document.createElement('strong')
      strong.textContent = item.query
      label.append(strong, document.createTextNode(` · day ${item.dayIndex}`))
      box.append(label)

      const options = [item.chosen, ...item.alternatives]
      options.forEach((candidate, index) => {
        const row = document.createElement('label')
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = `place:${item.placeId}`
        input.value = String(index)
        input.defaultChecked = index === 0

        const name = document.createElement('span')
        name.textContent = candidate.name
        const where = document.createElement('span')
        where.className = 'where'
        where.textContent = describe(candidate, item.chosen)

        row.append(input, name, where)
        box.append(row)
      })

      confirm.append(box)
    }

    const go = document.createElement('button')
    go.className = 'primary'
    go.type = 'button'
    go.textContent = 'Use these and continue'
    go.addEventListener('click', () => {
      const picks = pending.map((item) => {
        const selected = confirm.querySelector<HTMLInputElement>(
          `input[name="place:${CSS.escape(item.placeId)}"]:checked`,
        )
        const index = Number(selected?.value ?? 0)
        const options = [item.chosen, ...item.alternatives]
        return { placeId: item.placeId, candidate: options[index] ?? item.chosen }
      })
      go.disabled = true
      confirm.hidden = true
      resolve(picks)
    })
    confirm.append(go)

    intro.hidden = true
    confirm.hidden = false
    confirm.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

async function build(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const data = new FormData(form)
  const text = String(data.get('text') ?? '').trim()
  if (!text) {
    setStatus('Paste an itinerary first.')
    return
  }

  setFormDisabled(true)
  setStatus('Starting…')

  try {
    cache ??= await EntityCache.open(new LocalStorageStore())
    const title = String(data.get('title') ?? '').trim()
    const departs = String(data.get('departs') ?? '').trim()
    const options = {
      ...(title ? { title } : {}),
      ...(departs ? { departsOn: departs } : {}),
      onProgress: (stage: string, done: number, total: number) => {
        setStatus(total > 1 ? `${stage} (${done + 1} of ${total})` : stage)
      },
    }

    const d = deps()
    const resolved = await resolveTrip(text, d, options)

    let trip = resolved.trip
    if (resolved.pending.length > 0) {
      setStatus('')
      trip = applyChoices(trip, await askToConfirm(resolved.pending))
    }

    const result = await enrichTrip(trip, d, resolved.report, options)
    await cache.flush()

    const { build: b, fill: f, content: c } = result.reports
    setStatus(
      [
        `${b.resolved} stops`,
        b.unresolved.length ? `${b.unresolved.length} not found` : '',
        `${f.routed + f.walkFallback} legs routed`,
        c.refusals.length ? `${c.refusals.length} cards unconfirmed` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    )

    show(result.trip, c.refusals, true)
    history.replaceState(null, '', `#t=${await encodeTrip(result.trip)}`)
  } catch (err) {
    setStatus(`Could not build the briefing: ${(err as Error).message}`)
    confirm.hidden = true
    intro.hidden = false
  } finally {
    setFormDisabled(false)
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
  if (!target.getAttribute('data-flag')) return
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
  confirm.replaceChildren()
  confirm.hidden = true
  intro.hidden = false
  actions.hidden = true
  setStatus('')
})

void restoreFromHash()
