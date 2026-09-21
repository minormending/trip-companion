import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CacheSnapshot, CacheStore } from './store.ts'

/** Node-side persistence. Never imported by the browser bundle. */
export class FileStore implements CacheStore {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  async load(): Promise<CacheSnapshot> {
    try {
      return JSON.parse(await readFile(this.#path, 'utf8')) as CacheSnapshot
    } catch {
      return {}
    }
  }

  async save(snapshot: CacheSnapshot): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  }
}
