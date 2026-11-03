/**
 * File-backed credential store.
 *
 * The deployment's credential service is memory-only in some builds, so a token
 * set through the settings page disappeared on restart and its server failed
 * with CREDENTIAL_MISSING. Secrets written here live next to `registry.json`
 * (mode 0600 on POSIX) and are only used when the platform service has nothing.
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'credentials.json'

export class FileCredentialStore {
  constructor({ dir, logger } = {}) {
    this.dir = dir
    this.file = dir ? path.join(dir, FILE) : undefined
    this.logger = logger
    this.cache = undefined
  }

  #load() {
    if (this.cache !== undefined) return this.cache
    if (!this.file) {
      this.cache = {}
      return this.cache
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  async #flush() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.#load(), null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temp, this.file)
      try {
        fs.chmodSync(this.file, 0o600)
      } catch {
        // Windows has no equivalent mode; the directory ACL is the boundary.
      }
    } catch (error) {
      this.logger?.warn?.(`[mcp-connector] 凭据落盘失败：${error.message}`)
    }
  }

  /** @returns the stored secret or undefined. */
  async get(ref) {
    const value = this.#load()[ref]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  async set(ref, value) {
    this.#load()[ref] = String(value)
    await this.#flush()
    return { ref, stored: true }
  }

  async unset(ref) {
    const map = this.#load()
    if (ref in map) {
      delete map[ref]
      await this.#flush()
    }
    return { ref, unset: true }
  }

  /** Names only, never values. */
  list() {
    return Object.keys(this.#load())
  }
}
