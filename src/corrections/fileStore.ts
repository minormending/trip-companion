import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CorrectionPersistence, CorrectionSnapshot } from './store.ts'

/** Node-side persistence, for the CLI and for reviewing a collected batch. */
export class FileCorrections implements CorrectionPersistence {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  async load(): Promise<CorrectionSnapshot> {
    try {
      return JSON.parse(await readFile(this.#path, 'utf8')) as CorrectionSnapshot
    } catch {
      return {}
    }
  }

  async save(snapshot: CorrectionSnapshot): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  }
}
