import type { User } from '@supabase/supabase-js'
import { backendConfigured, currentUser, signIn, signOut, supabase } from '../src/backend/client.ts'

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
export function mountAuth(host: HTMLElement, onChange: (user: User | null) => void): AuthView {
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

    host.append(who, token, out)
    onChange(user)
  }

  /**
   * The form used to be an email box, a "Send link" button and nothing else.
   *
   * Two things went wrong with that, and both came back as "I don't understand
   * the sign-in". Somebody who has not met a magic link before looks for a
   * password field and finds none, with no text anywhere saying why. And the
   * one line of context the bar did carry — that the app is working locally —
   * vanished the moment they clicked, so the choice was presented with its
   * reason removed.
   *
   * So the panel now says what signing in is for before asking for anything,
   * and says there is no password before they go looking for one.
   */
  function showForm(): void {
    host.replaceChildren()

    const why = note(
      'Signing in keeps your trips on every device you use, and lets the daily Wanderlog sync write to your account. It is optional: everything here works signed out.',
    )
    const how = note('There is no password. Enter your email and we will send you a link that signs you in.')

    const field = document.createElement('input')
    field.type = 'email'
    field.placeholder = 'you@example.com'
    field.setAttribute('aria-label', 'Email address')

    const send = button('Email me a link')
    const cancel = button('Not now')
    const result = note('')

    send.addEventListener('click', () => {
      const email = field.value.trim()
      if (!email.includes('@')) {
        field.setAttribute('aria-invalid', 'true')
        result.className = 'auth-note bad'
        result.textContent = 'That does not look like an email address.'
        return
      }
      field.removeAttribute('aria-invalid')
      result.className = 'auth-note'
      send.disabled = true
      result.textContent = 'Sending\u2026'

      // A magic link means there is no password to store and none to leak.
      void signIn(email, location.href.split('#')[0] ?? location.href).then(({ error }) => {
        if (error) {
          result.className = 'auth-note bad'
          result.textContent = error
          send.disabled = false
          return
        }
        // A line of text under a form that still looks ready to submit reads
        // as though nothing happened. The form is replaced instead, so the
        // only thing left to do is the thing they now have to do.
        showSent(email)
      })
    })
    cancel.addEventListener('click', () => void render())

    host.append(why, how, field, send, cancel, result)
    field.focus()
  }

  /** What to do next, and nothing else to click by mistake. */
  function showSent(email: string): void {
    host.replaceChildren()
    host.append(
      note(`Check ${email} for a link from us, and open it in this browser. It signs you in; there is nothing to type.`),
    )

    const again = button('Use a different address')
    again.addEventListener('click', () => showForm())
    const cancel = button('Not now')
    cancel.addEventListener('click', () => void render())
    host.append(again, cancel)
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
