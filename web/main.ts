import { EntityCache } from '../src/cache/entityCache.ts'
import { LocalStorageStore } from '../src/cache/webStore.ts'
import { DeterministicProvider } from '../src/content/providers/deterministic.ts'
import { OverpassProvider } from '../src/content/providers/overpass.ts'
import { WikipediaProvider } from '../src/content/providers/wikipedia.ts'
import type { Refusal } from '../src/content/generate.ts'
import { checkIn, computeNow, type CheckIn } from '../src/companion/now.ts'
import { applyCorrections, recordFlag } from '../src/corrections/loop.ts'
import { CorrectionStore } from '../src/corrections/store.ts'
import { LocalStorageCorrections } from '../src/corrections/webStore.ts'
import type { Trip } from '../src/domain/types.ts'
import { haversineKm, PhotonGeocoder, type GeocodeCandidate } from '../src/geo/geocode.ts'
import type { PendingConfirmation } from '../src/import/build.ts'
import { applyChoices, enrichTrip, resolveTrip, type PipelineDeps } from '../src/pipeline.ts'
import { renderBriefing } from '../src/render/briefing.ts'
import { OsrmProvider } from '../src/routing/osrm.ts'
import { NullTransitProvider } from '../src/routing/transit.ts'
import { supabase } from '../src/backend/client.ts'
import { SupabaseCacheStore, SupabaseCorrections } from '../src/backend/stores.ts'
import { mountAuth } from './auth.ts'
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
const exportBtn = $<HTMLButtonElement>('export')
const modeBtn = $<HTMLButtonElement>('mode')
const nowPane = $<HTMLDivElement>('now')
const resumePane = $<HTMLDivElement>('resume')

const authPane = $<HTMLDivElement>('auth')

const TRIP_KEY = 'trip-companion:trip'
const CHECKIN_KEY = 'trip-companion:checkins'

let checkIns: CheckIn[] = []
let companionMode = false

let signedInUserId: string | null = null

/**
 * Signed in, the shared Supabase stores back the same interfaces the local
 * ones do, so the domain layer never learns there is a backend. Signed out it
 * is localStorage, exactly as before.
 */
async function openStores(force = false): Promise<void> {
  const db = supabase()
  if (force) {
    cache = null
    corrections = null
  }
  if (db && signedInUserId) {
    cache ??= await EntityCache.open(new SupabaseCacheStore(db))
    corrections ??= await CorrectionStore.open(new SupabaseCorrections(db))
    return
  }
  cache ??= await EntityCache.open(new LocalStorageStore())
  corrections ??= await CorrectionStore.open(new LocalStorageCorrections())
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode: the trip is still usable for this session */
  }
}

let cache: EntityCache | null = null
let corrections: CorrectionStore | null = null
/** The trip before corrections. Held uncorrected so a later review that
 *  rejects a flag can bring the card back rather than losing it for good. */
let baseTrip: Trip | null = null
let baseRefusals: Refusal[] = []

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
    // Corrections are deliberately NOT passed here. The browser re-applies
    // them on every render so a flag takes effect immediately; letting the
    // pipeline apply them as well would strip the cards before the render
    // could say they had been withdrawn.
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
  baseTrip = trip
  baseRefusals = refusals
  if (interactive) {
    // Saved so the companion opens on a platform with no signal, which is the
    // only situation in which it is actually needed.
    writeLocal(TRIP_KEY, { trip, refusals })
  }
  render(interactive)
}

/** Corrections are re-applied on every render, so a flag takes effect at once. */
function render(interactive: boolean): void {
  if (!baseTrip) return
  const applied = corrections
    ? applyCorrections(baseTrip, corrections)
    : { trip: baseTrip, withdrawn: [] as Refusal[] }

  mountBriefing(
    renderBriefing(applied.trip, {
      refusals: [...baseRefusals, ...applied.withdrawn],
      interactive,
    }),
  )
  renderNow(applied.trip)
  modeBtn.hidden = false
  modeBtn.textContent = companionMode ? 'Full briefing' : 'Companion'
  nowPane.hidden = !companionMode
  output.hidden = companionMode
  exportBtn.hidden = !corrections || corrections.size === 0
}

/**
 * The in-transit view. Everything already behind the traveller is gone, and
 * what can strand them is at the top: standing on a platform, a card about
 * where to board outranks the history of the building.
 */
function renderNow(trip: Trip): void {
  const state = computeNow(trip, checkIns)
  nowPane.replaceChildren()

  if (!navigator.onLine) {
    const offline = document.createElement('p')
    offline.className = 'now-offline'
    offline.textContent = 'Offline \u2014 showing what was saved before you left'
    nowPane.append(offline)
  }

  const progress = document.createElement('p')
  progress.className = 'now-progress'
  progress.textContent = `${state.reached} of ${state.total} stops reached`
  nowPane.append(progress)

  if (state.complete || !state.next) {
    const done = document.createElement('div')
    done.className = 'now-done'
    done.textContent = 'Every stop reached. The full briefing is still here if you want it.'
    nowPane.append(done)
    return
  }

  const next = document.createElement('h2')
  next.className = 'now-next'
  next.textContent = state.next.name
  nowPane.append(next)

  const leg = document.createElement('p')
  leg.className = 'now-leg'
  if (state.leg) {
    const bits: string[] = []
    if (state.leg.durationMinutes !== undefined) bits.push(`${state.leg.durationMinutes} min`)
    if (state.leg.distanceMetres !== undefined) {
      bits.push(
        state.leg.distanceMetres >= 1000
          ? `${(state.leg.distanceMetres / 1000).toFixed(1)} km`
          : `${state.leg.distanceMetres} m`,
      )
    }
    const mode = document.createElement('span')
    mode.className = 'mode'
    mode.textContent = state.leg.mode
    leg.append(mode, document.createTextNode(bits.length ? ` \u00b7 ${bits.join(' \u00b7 ')}` : ''))
  } else if (state.next.arrive) {
    leg.textContent = `Due at ${state.next.arrive}`
  } else {
    leg.textContent = 'First stop'
  }
  nowPane.append(leg)

  const here = document.createElement('button')
  here.className = 'now-here'
  here.type = 'button'
  here.textContent = `I'm at ${state.next.name}`
  here.addEventListener('click', () => {
    checkIns = checkIn(checkIns, state.next!.id)
    writeLocal(CHECKIN_KEY, checkIns)
    render(true)
  })
  nowPane.append(here)

  // Rendered through the same renderer as the briefing, so tier treatment,
  // provenance and guide behaviour are identical in both views rather than
  // reimplemented and drifting apart. The cards are re-pointed at the next
  // stop so they group under it.
  const asStop: Trip = {
    ...trip,
    places: [{ ...state.next, dayIndex: 1 }],
    legs: [],
    cards: state.cards.map((card) => ({
      ...card,
      attachesTo: { kind: 'place' as const, placeId: state.next!.id },
    })),
  }
  const fragment = new DOMParser().parseFromString(
    renderBriefing(asStop, { interactive: true }),
    'text/html',
  )
  const host = document.createElement('div')
  for (const card of Array.from(fragment.querySelectorAll('.stop .card'))) {
    host.append(document.importNode(card, true))
  }
  nowPane.append(host)
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
    await openStores()
    checkIns = readLocal<CheckIn[]>(CHECKIN_KEY, [])
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
    await cache?.flush()

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
  setStatus('Opening a briefing\u2026')
  const trip = await decodeTrip(match[1])
  if (!trip) {
    setStatus('That link could not be read.')
    return false
  }

  // Building a trip leaves its own share link in the address bar, so a reload
  // would otherwise demote the traveller's own briefing to somebody else's and
  // strip the check-in along with it. A trip whose id matches the one saved on
  // this device is ours.
  const saved = readLocal<{ trip: Trip; refusals: Refusal[] } | null>(TRIP_KEY, null)
  await openStores()
  checkIns = readLocal<CheckIn[]>(CHECKIN_KEY, [])

  if (saved?.trip?.id === trip.id) {
    show(trip, saved.refusals ?? [], true)
    setStatus('')
    return true
  }

  // A shared briefing is somebody else's record, so the flag and regenerate
  // controls are withheld: corrections belong to the traveller who was there.
  show(trip, [], false)
  setStatus('Shared briefing \u2014 read only.')
  return true
}

form.addEventListener('submit', (e) => void build(e))

/**
 * A flag without a claim is nearly useless to whoever reviews it: "wrong" does
 * not say what the machine actually did. The text costs the traveller ten
 * seconds and is the whole value of the report.
 */
function openClaimForm(button: HTMLElement, cardId: string): void {
  const controls = button.parentElement
  const card = button.closest('.card')
  if (!controls || !card || card.querySelector('.claim')) return

  const form = document.createElement('div')
  form.className = 'claim'

  const field = document.createElement('textarea')
  field.rows = 2
  field.placeholder = 'What was actually true? e.g. the machine took coins only'
  field.setAttribute('aria-label', 'What was wrong')

  const send = document.createElement('button')
  send.type = 'button'
  send.textContent = 'Send'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'

  const row = document.createElement('div')
  row.className = 'claim-actions'
  row.append(send, cancel)
  form.append(field, row)
  controls.insertAdjacentElement('afterend', form)
  field.focus()

  cancel.addEventListener('click', () => form.remove())
  send.addEventListener('click', () => {
    const claim = field.value.trim()
    if (!claim) {
      field.setAttribute('aria-invalid', 'true')
      field.placeholder = 'Say what was actually true, so it can be checked'
      return
    }
    if (!baseTrip || !corrections) return

    const result = recordFlag(baseTrip, { cardId, claim }, corrections, cache ?? undefined)
    void corrections.flush()
    void cache?.flush()
    form.remove()

    if (result?.suppressed) {
      // Enough people have doubted it that it should stop being shown as fact.
      setStatus('Thank you. Enough travellers have reported this that it is now withdrawn pending review.')
      render(true)
    } else {
      button.textContent = 'Reported, thank you'
      ;(button as HTMLButtonElement).disabled = true
      exportBtn.hidden = false
    }
  })
}

output.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const cardId = target.getAttribute('data-flag')
  if (!cardId) return
  openClaimForm(target, cardId)
})

exportBtn.addEventListener('click', () => {
  if (!corrections) return
  // No backend in v1, so reports leave the device the only way they can.
  const blob = new Blob([JSON.stringify(corrections.all(), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'trip-companion-corrections.json'
  link.click()
  URL.revokeObjectURL(url)
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

modeBtn.addEventListener('click', () => {
  companionMode = !companionMode
  render(true)
})

printBtn.addEventListener('click', () => window.print())

restartBtn.addEventListener('click', () => {
  history.replaceState(null, '', location.pathname)
  baseTrip = null
  baseRefusals = []
  companionMode = false
  nowPane.hidden = true
  modeBtn.hidden = true
  output.hidden = false
  output.replaceChildren()
  confirm.replaceChildren()
  confirm.hidden = true
  intro.hidden = false
  actions.hidden = true
  setStatus('')
})

/**
 * A trip saved on the last visit opens without a network, which is the whole
 * point: the companion is needed exactly where there is no signal.
 */
function offerSavedTrip(): void {
  const saved = readLocal<{ trip: Trip; refusals: Refusal[] } | null>(TRIP_KEY, null)
  if (!saved?.trip?.places?.length) return

  resumePane.replaceChildren()
  const line = document.createElement('p')
  line.style.margin = '0 0 0.6rem'
  line.textContent = `You have "${saved.trip.title}" saved on this device.`
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = 'Open it'
  const discard = document.createElement('button')
  discard.type = 'button'
  discard.textContent = 'Discard'

  open.addEventListener('click', () => {
    void (async () => {
      await openStores()
      checkIns = readLocal<CheckIn[]>(CHECKIN_KEY, [])
      resumePane.hidden = true
      companionMode = true
      show(saved.trip, saved.refusals ?? [], true)
    })()
  })
  discard.addEventListener('click', () => {
    try {
      globalThis.localStorage?.removeItem(TRIP_KEY)
      globalThis.localStorage?.removeItem(CHECKIN_KEY)
    } catch {
      /* nothing to clear */
    }
    resumePane.hidden = true
  })

  resumePane.append(line, open, discard)
  resumePane.hidden = false
}

// Wrapped: the bundle is an IIFE, which cannot carry a top-level await.
void (async () => {
  if (!(await restoreFromHash())) offerSavedTrip()
})()

mountAuth(authPane, (user) => {
  const next = user?.id ?? null
  if (next === signedInUserId) return
  signedInUserId = next
  // Swapping identity swaps which stores are in play, so they are reopened.
  void openStores(true).then(() => {
    if (baseTrip) render(true)
  })
})

// Registered last so a failure here never blocks the app starting.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('sw.js').catch(() => undefined)
  })
}

addEventListener('online', () => render(true))
addEventListener('offline', () => render(true))
