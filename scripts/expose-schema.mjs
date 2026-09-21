#!/usr/bin/env node
/**
 * Add an app's schema to the ones PostgREST serves.
 *
 *   node scripts/expose-schema.mjs trip            show what it would do
 *   node scripts/expose-schema.mjs trip --apply
 *
 * A schema that exists in Postgres is still invisible to the API until it is
 * listed here, and the failure is a confusing 404 from a table you can see in
 * the dashboard. This is a documented Management API field rather than the
 * dashboard-only setting it looks like.
 *
 * Needs SUPABASE_ACCESS_TOKEN and PUBLIC_SUPABASE_URL in .env.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = join(ROOT, '.env')
const APPLY = process.argv.includes('--apply')
const SCHEMA = process.argv[2]

if (!SCHEMA || SCHEMA.startsWith('--')) {
  console.error('Usage: node scripts/expose-schema.mjs <schema> [--apply]')
  process.exit(2)
}

if (existsSync(ENV)) {
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && m[2].trim() && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const REF = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(process.env.PUBLIC_SUPABASE_URL ?? '')?.[1]
if (!TOKEN || !REF) {
  console.error('needs SUPABASE_ACCESS_TOKEN and PUBLIC_SUPABASE_URL in .env')
  process.exit(1)
}

const url = `https://api.supabase.com/v1/projects/${REF}/postgrest`
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const current = await (await fetch(url, { headers })).json()
const schemas = current.db_schema.split(',').map((s) => s.trim()).filter(Boolean)

if (schemas.includes(SCHEMA)) {
  console.log(`"${SCHEMA}" is already exposed: ${schemas.join(', ')}`)
  process.exit(0)
}

console.log(`  from  ${schemas.join(',')}`)
console.log(`  to    ${[...schemas, SCHEMA].join(',')}`)

if (!APPLY) {
  console.log('\ndry run — pass --apply to write it')
  process.exit(0)
}

const res = await fetch(url, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ db_schema: [...schemas, SCHEMA].join(',') }),
})
if (!res.ok) {
  console.error(`PATCH failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
// Deliberately not printing the whole response: it carries the JWT secret.
const after = await res.json()
console.log(`\nexposed. db_schema is now: ${after.db_schema}`)
