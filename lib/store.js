/**
 * Durable runtime server registry.
 *
 * The registry — not the Cordis row — is the source of truth for *which servers
 * exist*. That is the deliberate split this plugin documents: the Cordis config
 * carries deployment policy only, so adding or editing a server is a registry
 * write plus one connection swap, never an HMR remount of the plugin.
 *
 * Records are stored as one JSON document with an explicit `version`, written
 * atomically (temp file + rename) so a crash mid-write cannot truncate the list.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CODES, McpDiagnostic, PHASES } from './diagnostics.js'
import { blockingIssues, normalizeEntry } from './normalize.js'

/** Bumped only for a breaking record-shape change; loaders migrate older ones. */
export const REGISTRY_VERSION = 1

/**
 * The on-disk document.
 * @typedef {{ version: number, updatedAt: string, servers: ServerRecord[] }} RegistryDocument
 */

/** A stored server record: identity + connection parameters + provenance. */
function makeRecord({ serverName, config, disabled = false, source = 'manual' }) {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    serverName,
    disabled,
    config,
    source,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The registry store: pure data, no connections.
 *
 * Read is synchronous from memory (the settings page polls often); writes are
 * serialized through one promise chain and land on disk before they resolve.
 */
export class RegistryStore {
  #entries = []
  #writeChain = Promise.resolve()
  #loaded = false

  /**
   * @param options.dir - directory holding `registry.json`.
   * @param options.persist - false keeps the registry in memory only.
   * @param options.logger - optional `{ warn, error }` sink.
   */
  constructor({ dir, persist = true, logger }) {
    this.dir = dir
    this.file = path.join(dir, 'registry.json')
    this.persist = persist
    this.logger = logger
  }

  /** The live records (a defensive copy). */
  list() {
    return this.#entries.map((entry) => structuredClone(entry))
  }

  /** One record by id, or `undefined`. */
  get(id) {
    const found = this.#entries.find((entry) => entry.id === id)
    return found ? structuredClone(found) : undefined
  }

  /** One record by serverName, or `undefined`. */
  getByName(serverName) {
    const found = this.#entries.find((entry) => entry.serverName === serverName)
    return found ? structuredClone(found) : undefined
  }

  /** Whether a serverName is taken (optionally ignoring one id). */
  nameTaken(serverName, exceptId) {
    return this.#entries.some((entry) => entry.serverName === serverName && entry.id !== exceptId)
  }

  /**
   * Load the registry from disk.
   *
   * A missing file is an empty registry; a corrupt file is reported and kept
   * aside (`registry.corrupt-<ts>.json`) rather than deleted, so the user can
   * recover hand-written entries.
   *
   * @returns the loaded records.
   */
  async load() {
    if (!this.persist) {
      this.#loaded = true
      return this.list()
    }
    let text
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.(`[mcp-connector] 读取注册表失败：${error?.message ?? error}`)
      }
      this.#loaded = true
      return this.list()
    }
    let document
    try {
      document = JSON.parse(text)
    } catch {
      await this.#quarantine(text)
      this.#loaded = true
      return this.list()
    }
    const records = []
    const servers = Array.isArray(document?.servers) ? document.servers : []
    let index = 0
    for (const raw of servers) {
      // Records written by this plugin already carry `id` + `config`; a
      // hand-edited file may carry bare entries, so both go through validation.
      if (raw && typeof raw === 'object' && raw.config && typeof raw.serverName === 'string') {
        const { entry, issues } = normalizeEntry({ serverName: raw.serverName, ...raw.config, disabled: raw.disabled }, { index })
        if (entry === undefined || blockingIssues(issues).length > 0) {
          this.logger?.warn?.(`[mcp-connector] 跳过非法注册表条目 ${raw.serverName ?? index}`)
          index += 1
          continue
        }
        records.push({
          id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
          serverName: entry.serverName,
          disabled: Boolean(raw.disabled),
          config: entry.config,
          source: typeof raw.source === 'string' ? raw.source : 'manual',
          createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
        })
      } else {
        const { entry, issues } = normalizeEntry(raw, { index })
        if (entry === undefined || blockingIssues(issues).length > 0) {
          index += 1
          continue
        }
        records.push({ ...makeRecord(entry), disabled: entry.disabled })
      }
      index += 1
    }
    this.#entries = dedupeByName(records, this.logger)
    this.#loaded = true
    return this.list()
  }

  /** Whether `load()` has completed. */
  get loaded() {
    return this.#loaded
  }

  /**
   * Insert one entry.
   * @returns the stored record.
   */
  async insert({ serverName, config, disabled = false, source = 'manual' }) {
    if (this.nameTaken(serverName)) {
      throw new McpDiagnostic(CODES.SERVER_NAME_CONFLICT, PHASES.config, `serverName "${serverName}" 已被占用`, { serverName })
    }
    const record = makeRecord({ serverName, config, disabled, source })
    this.#entries.push(record)
    await this.flush()
    return structuredClone(record)
  }

  /**
   * Update one entry. `serverName` is immutable: it is already the tool-name
   * prefix agents saw, so renaming means delete + create.
   * @returns the updated record.
   */
  async update(id, { config, disabled }) {
    const index = this.#entries.findIndex((entry) => entry.id === id)
    if (index === -1) throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, `找不到服务器 ${id}`, { id })
    const current = this.#entries[index]
    const next = {
      ...current,
      ...(config !== undefined ? { config } : {}),
      ...(disabled !== undefined ? { disabled: Boolean(disabled) } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.#entries[index] = next
    await this.flush()
    return structuredClone(next)
  }

  /** Remove one entry. @returns the removed record. */
  async remove(id) {
    const index = this.#entries.findIndex((entry) => entry.id === id)
    if (index === -1) throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, `找不到服务器 ${id}`, { id })
    const [removed] = this.#entries.splice(index, 1)
    await this.flush()
    return structuredClone(removed)
  }

  /**
   * Apply a batch atomically: upserts, removals and new inserts land in a single
   * write, so a full JSON overwrite cannot observe a half-applied list.
   *
   * @param plan - `{ upsert: [{ serverName, config, disabled }], remove: [id], replace: boolean }`.
   * @returns `{ added, updated, removed }` receipts.
   */
  async applyBatch(plan) {
    const added = []
    const updated = []
    const removed = []
    const next = plan.replace ? [] : this.#entries.map((entry) => ({ ...entry }))

    for (const name of plan.remove ?? []) {
      const index = next.findIndex((entry) => entry.id === name)
      if (index === -1) continue
      removed.push(next[index].serverName)
      next.splice(index, 1)
    }

    for (const incoming of plan.upsert ?? []) {
      const index = next.findIndex((entry) => entry.serverName === incoming.serverName)
      if (index === -1) {
        const record = makeRecord({ ...incoming, source: incoming.source ?? 'import' })
        next.push(record)
        added.push(record.serverName)
        continue
      }
      next[index] = {
        ...next[index],
        config: incoming.config,
        disabled: Boolean(incoming.disabled),
        updatedAt: new Date().toISOString(),
      }
      updated.push(next[index].serverName)
    }

    if (plan.replace) {
      for (const entry of this.#entries) {
        if (!next.some((item) => item.serverName === entry.serverName)) removed.push(entry.serverName)
      }
      // A replace keeps ids of survivors so their live connections survive too.
      for (const entry of next) {
        const previous = this.#entries.find((item) => item.serverName === entry.serverName)
        if (previous) entry.id = previous.id
      }
    }

    this.#entries = dedupeByName(next, this.logger)
    await this.flush()
    return { added, updated, removed }
  }

  /** Persist the current in-memory state. */
  async flush() {
    if (!this.persist) return
    const document = {
      version: REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      servers: this.#entries.map((entry) => ({ ...entry })),
    }
    const body = `${JSON.stringify(document, null, 2)}\n`
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await fs.writeFile(temp, body, 'utf8')
      await fs.rename(temp, this.file)
    }
    this.#writeChain = this.#writeChain.then(run, run)
    return this.#writeChain
  }

  /** Move an unparseable file aside so the user can inspect it. */
  async #quarantine(text) {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      const target = path.join(this.dir, `registry.corrupt-${Date.now()}.json`)
      await fs.writeFile(target, text, 'utf8')
      this.logger?.warn?.(`[mcp-connector] 注册表不是合法 JSON，已另存为 ${path.basename(target)}`)
    } catch (error) {
      this.logger?.warn?.(`[mcp-connector] 无法备份损坏的注册表：${error?.message ?? error}`)
    }
  }
}

/** Keep the first record for each serverName; later duplicates are dropped. */
function dedupeByName(records, logger) {
  const seen = new Set()
  const output = []
  for (const record of records) {
    if (seen.has(record.serverName)) {
      logger?.warn?.(`[mcp-connector] 注册表里 serverName "${record.serverName}" 重复，保留第一条`)
      continue
    }
    seen.add(record.serverName)
    output.push(record)
  }
  return output
}
