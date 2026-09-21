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
      const label = document.createElement('span')
      label.textContent = 'Working locally. '
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

  function showForm(): void {
    host.replaceChildren()
    const field = document.createElement('input')
    field.type = 'email'
    field.placeholder = 'you@example.com'
    field.setAttribute('aria-label', 'Email address')

    const send = button('Send link')
    const cancel = button('Cancel')
    const note = document.createElement('p')
    note.className = 'auth-note'

    send.addEventListener('click', () => {
      const email = field.value.trim()
      if (!email.includes('@')) {
        field.setAttribute('aria-invalid', 'true')
        note.textContent = 'That does not look like an email address.'
        return
      }
      send.disabled = true
      // A magic link means there is no password to store and none to leak.
      void signIn(email, location.href.split('#')[0] ?? location.href).then(({ error }) => {
        note.textContent = error ? error : 'Check your email for a sign-in link.'
        send.disabled = false
      })
    })
    cancel.addEventListener('click', () => void render())

    host.append(field, send, cancel, note)
    field.focus()
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
