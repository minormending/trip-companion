import type { User } from '@supabase/supabase-js'
import { backendConfigured, currentUser, signInWithGoogle, signOut, supabase } from '../src/backend/client.ts'
import { TripRepository, type SavedTrip } from '../src/backend/trips.ts'
import type { Trip } from '../src/domain/types.ts'

export interface AuthView {
  user: User | null
  /** Re-renders the bar; call after anything that changes session state. */
  refresh(): Promise<void>
}

function button(label: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  return element
}

function note(text: string): HTMLParagraphElement {
  const element = document.createElement('p')
  element.className = 'auth-note'
  element.textContent = text
  return element
}

/**
 * Signing in is optional. Signed out the app is exactly what it was before a
 * backend existed — everything local, nothing shared — and that mode has to
 * keep working, because it is what the Pages deploy ran on for several phases.
 */
export function mountAuth(
  host: HTMLElement,
  onChange: (user: User | null) => void,
  onOpenTrip?: (trip: Trip) => void,
): AuthView {
  const view: AuthView = { user: null, refresh: async () => {} }

  if (!backendConfigured()) {
    host.hidden = true
    return view
  }

  /**
   * Renders are sequenced by generation. supabase fires onAuthStateChange with
   * the initial session as soon as it is subscribed, which raced the first
   * render: both cleared the host, both awaited, and both appended, so the bar
   * drew itself twice.
   */
  let generation = 0

  async function render(): Promise<void> {
    const mine = ++generation
    const user = await currentUser()
    if (mine !== generation) return

    host.replaceChildren()
    host.hidden = false
    view.user = user

    if (!user) {
      // Two questions to answer before anybody clicks: what state am I in
      // now, and what would change. "Working locally." answered neither, and
      // "sync" on its own reads as a demand rather than an offer.
      const label = document.createElement('span')
      label.textContent = 'Working locally \u2014 nothing leaves this device. '
      const link = button('Sign in to sync')
      link.addEventListener('click', () => showForm())
      host.append(label, link)
      onChange(null)
      return
    }

    const who = document.createElement('span')
    who.textContent = `Signed in as ${user.email ?? 'you'}. `

    const token = button('Copy sync token')
    token.addEventListener('click', () => void copySyncToken(token))

    const out = button('Sign out')
    out.addEventListener('click', () => {
      void signOut().then(() => render())
    })

    // "Signed in as you@…" was the whole confirmation, which answers the one
    // question nobody was asking. What people wanted to know is whether
    // anything of theirs is actually up there.
    const summary = note('Reading your account\u2026')

    host.append(who, token, out, summary)
    onChange(user)

    const db = supabase()
    if (!db) return
    const saved = await new TripRepository(db, user.id).list()
    if (mine !== generation) return
    showSaved(summary, saved)
  }

  /**
   * What is in the account, by name.
   *
   * An empty account says so rather than staying silent, because "nothing
   * synced" and "we did not check" look identical to somebody who has just
   * signed in wondering whether it worked.
   */
  function showSaved(host_: HTMLElement, saved: SavedTrip[]): void {
    host_.replaceChildren()
    if (saved.length === 0) {
      host_.textContent = 'Nothing saved to your account yet. The next briefing you build is saved here, and so is anything the daily sync uploads.'
      return
    }

    const count = saved.length === 1 ? '1 trip' : `${saved.length} trips`
    host_.append(document.createTextNode(`${count} in your account: `))

    saved.slice(0, 6).forEach((trip, index) => {
      if (index > 0) host_.append(document.createTextNode(' '))
      const open = button(trip.title || 'Untitled trip')
      open.title = `Saved ${trip.updatedAt.slice(0, 10)} from ${trip.source}`
      open.addEventListener('click', () => onOpenTrip?.(trip.graph))
      host_.append(open)
    })

    if (saved.length > 6) host_.append(document.createTextNode(` and ${saved.length - 6} more.`))
  }

  /**
   * Why, then the button.
   *
   * The panel this replaced asked for an email address and sent a link. The
   * reported confusion was not its wording: a sign-in that hands you to your
   * inbox and depends on you coming back to the same browser has three places
   * to lose somebody, and no amount of explaining removes them. Google already
   * owns that problem.
   *
   * The "why" survives the change, because it was the other half of the
   * complaint — an offer to sync means nothing without saying what is synced,
   * and the bar's own "working locally" line disappears the moment this opens.
   */
  function showForm(): void {
    host.replaceChildren()

    host.append(
      note(
        'Signing in keeps your briefings in your account, so they open on any device you use. It is optional: everything here works signed out.',
      ),
    )

    const go = button('Continue with Google')
    go.addEventListener('click', () => {
      go.disabled = true
      const back = location.href.split('#')[0] ?? location.href
      void signInWithGoogle(back).then(({ error }) => {
        if (!error) return
        // Nothing redirected, so the panel is still here to say why.
        go.disabled = false
        const failed = note(error)
        failed.className = 'auth-note bad'
        host.append(failed)
      })
    })

    const cancel = button('Not now')
    cancel.addEventListener('click', () => void render())

    host.append(go, cancel)
  }

  /**
   * The refresh token is what the sync script uses to act as this user. It is
   * shown only on an explicit click, and it is the user's own credential going
   * into the user's own secret store.
   */
  async function copySyncToken(trigger: HTMLButtonElement): Promise<void> {
    const db = supabase()
    if (!db) return
    const { data } = await db.auth.getSession()
    const token = data.session?.refresh_token
    if (!token) {
      trigger.textContent = 'No active session'
      return
    }
    try {
      await navigator.clipboard.writeText(token)
      trigger.textContent = 'Copied — put it in SUPABASE_REFRESH_TOKEN'
    } catch {
      trigger.textContent = 'Could not copy'
    }
    setTimeout(() => (trigger.textContent = 'Copy sync token'), 4000)
  }

  view.refresh = render
  void render()

  supabase()?.auth.onAuthStateChange(() => {
    void render()
  })

  return view
}
