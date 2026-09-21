import type { Trip } from '../src/domain/types.ts'

/**
 * A briefing has to be shareable without a backend, so the whole trip graph
 * travels in the URL fragment: gzipped, base64url, never sent to a server.
 */
type Bytes = Uint8Array<ArrayBuffer>

async function pipe(data: Bytes, format: 'gzip', mode: 'compress' | 'decompress'): Promise<Bytes> {
  const stream =
    mode === 'compress' ? new CompressionStream(format) : new DecompressionStream(format)
  const writer = stream.writable.getWriter()

  // Feeding a decompressor invalid bytes rejects on both ends. The write side
  // is swallowed deliberately so the failure surfaces once, from the reader.
  const written = writer
    .write(data)
    .then(() => writer.close())
    .catch(() => undefined)

  const chunks: Bytes[] = []
  const reader = stream.readable.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value as Bytes)
    }
  } finally {
    await written
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function toBase64Url(bytes: Bytes): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Bytes {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export async function encodeTrip(trip: Trip): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(trip)) as Bytes
  return toBase64Url(await pipe(json, 'gzip', 'compress'))
}

export async function decodeTrip(encoded: string): Promise<Trip | null> {
  try {
    const bytes = await pipe(fromBase64Url(encoded), 'gzip', 'decompress')
    return JSON.parse(new TextDecoder().decode(bytes)) as Trip
  } catch {
    return null
  }
}
