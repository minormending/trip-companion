import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const DIST = new URL('../dist/', import.meta.url).pathname
const PORT = Number(process.env['PORT'] ?? 8788)
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

createServer((req, res) => {
  void (async () => {
    const requested = new URL(req.url ?? '/', 'http://localhost').pathname
    const rel = normalize(requested).replace(/^(\.\.[/\\])+/, '')
    const file = join(DIST, rel === '/' ? 'index.html' : rel)
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(res)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  })()
}).listen(PORT, () => console.log(`dist/ on http://localhost:${PORT}`))
