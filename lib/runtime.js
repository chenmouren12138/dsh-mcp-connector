/**
 * Runtime server registry: one supervised connection per server, the explicit
 * connection state machine, tool synchronization and call accounting.
 *
 * Everything the settings page shows comes from {@link McpRuntime.snapshot}: the
 * page never inspects a connection object, so internals stay free to change.
 *
 * Lifecycle rules this module enforces:
 * - a server's connection is created and disposed independently, so editing one
 *   server never touches another;
 * - deleting or disabling a server disposes its connection and unregisters its
 *   tools through the effect disposers;
 * - `dispose()` (plugin unload) stops timers, closes connections in reverse
 *   creation order and disposes every tool generation.
 */
import { CODES, McpDiagnostic, PHASES, asDiagnostic } from './diagnostics.js'
import { McpConnection, probeConnection } from './connection.js'
import {
  describeEntry,
  exportEntries,
  issueToDiagnostic,
  normalizeDraft,
  normalizeImport,
} from './normalize.js'
import { disposeTools, publicToolName, registerServerTools } from './toolbridge.js'
import { RegistryStore } from './store.js'
import { collectCredentialRefs, describeCredentials, resolveCredentials } from './credentials.js'
import { FileCredentialStore } from './credential-store.js'
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  discoverAuthorizationServer,
  discoverProtectedResource,
  exchangeCode,
  refreshAccessToken,
  registerClient,
  startLoopbackServer,
} from './oauth.js'

/** The explicit connection states, per the plugin's state-machine contract. */
export const STATES = Object.freeze({
  draft: 'draft',
  connecting: 'connecting',
  initializing: 'initializing',
  ready: 'ready',
  degraded: 'degraded',
  reconnecting: 'reconnecting',
  error: 'error',
  disabled: 'disabled',
})

const TERMINAL_OK = new Set([STATES.ready, STATES.degraded])

/** Human sentence per state, used by receipts and the page's tooltips. */
export const STATE_LABELS = Object.freeze({
  draft: '草稿',
  connecting: '连接中',
  initializing: '握手中',
  ready: '就绪',
  degraded: '降级可用',
  reconnecting: '重连中',
  error: '错误',
  disabled: '已禁用',
})

function nowIso() {
  return new Date().toISOString()
}

/** Trim a diagnostic for the page: no stack, no unbounded payloads. */
function presentDiagnostic(diagnostic, at = nowIso()) {
  if (!diagnostic) return null
  const json = diagnostic instanceof McpDiagnostic ? diagnostic.toJSON() : diagnostic
  return {
    code: json.code,
    phase: json.phase,
    message: json.message,
    detail: json.detail ?? {},
    at,
  }
}

/**
 * The registry runtime.
 *
 * Construct once per plugin instance; `init()` loads persisted records and opens
 * connections, `dispose()` releases everything.
 */
export class McpRuntime {
  #servers = new Map()
  #listeners = new Set()
  #startedAt = new Date().toISOString()
  #disposed = false
  #store

  #credentialsFile

  /**
   * @param options.ctx - Cordis context supplying `tools` and `emit`.
   * @param options.config - resolved deployment config.
   * @param options.dataDir - directory holding `registry.json`.
   * @param options.logger - `{ info, warn, error }` sink (defaults to console).
   */
  constructor({ ctx, config, dataDir, logger }) {
    this.ctx = ctx
    this.config = config
    this.logger = logger ?? console
    this.#store = new RegistryStore({ dir: dataDir, persist: config.registry.persist, logger: this.logger })
    this.#credentialsFile = new FileCredentialStore({ dir: dataDir, logger: this.logger })
  }

  /** The store handle, exposed for tests and diagnostics. */
  get store() {
    return this.#store
  }

  /**
   * Load the registry and connect every enabled, non-disabled server.
   * @returns the initial snapshot.
   */
  async init() {
    await this.#store.load()
    for (const record of this.#store.list()) {
      const server = this.#createServer(record)
      this.#servers.set(record.id, server)
    }
    for (const server of this.#servers.values()) {
      if (server.record.config.transport === 'stdio') continue
      await this.#restoreOAuth(server).catch(() => {})
    }
    if (!this.config.enabled) {
      for (const server of this.#servers.values()) server.state = STATES.disabled
      this.logger.info?.('[mcp-connector] 插件已停用（enabled=false），不建立任何连接')
      return this.snapshot()
    }
    for (const server of this.#servers.values()) {
      if (server.record.disabled || !this.config.registry.enabled) {
        server.state = STATES.disabled
        continue
      }
      this.connect(server).catch((error) => {
        this.logger.warn?.(`[mcp-connector] ${server.record.serverName} 首次连接失败：${error?.message ?? error}`)
      })
    }
    return this.snapshot()
  }

  /**
   * Subscribe to state changes.
   * @param listener - `(event) => void`.
   * @returns unsubscribe.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * The complete UI-facing snapshot: deployment policy, every server with its
   * state/diagnostics/tools, and aggregate counters.
   */
  snapshot() {
    const servers = [...this.#servers.values()]
      .map((server) => this.#present(server))
      .sort((a, b) => a.serverName.localeCompare(b.serverName))
    const counts = {
      total: servers.length,
      ready: servers.filter((item) => item.state === STATES.ready).length,
      degraded: servers.filter((item) => item.state === STATES.degraded).length,
      error: servers.filter((item) => item.state === STATES.error).length,
      disabled: servers.filter((item) => item.state === STATES.disabled).length,
      connecting: servers.filter((item) => [STATES.connecting, STATES.initializing, STATES.reconnecting].includes(item.state)).length,
    }
    const tools = servers.reduce((total, item) => total + item.toolCount, 0)
    const toolCalls = servers.reduce((total, item) => total + item.stats.toolCalls, 0)
    const toolErrors = servers.reduce((total, item) => total + item.stats.toolErrors, 0)
    return {
      config: {
        enabled: this.config.enabled,
        registryEnabled: this.config.registry.enabled,
        persist: this.config.registry.persist,
        dataDir: this.#store.dir,
        defaultTimeoutMs: this.config.defaultTimeoutMs,
        probeTimeoutMs: this.config.probeTimeoutMs,
        toolCallTimeoutMs: this.config.toolCallTimeoutMs,
        allowedTransports: [...this.config.allowedTransports],
        exposeTools: this.config.exposeTools,
        reconnect: { ...this.config.reconnect },
        probeIntervalMs: this.config.probeIntervalMs,
      },
      servers,
      stats: {
        ...counts,
        tools,
        toolCalls,
        toolErrors,
        startedAt: this.#startedAt,
        uptimeMs: Date.now() - Date.parse(this.#startedAt),
        successRate: toolCalls === 0 ? null : Number(((toolCalls - toolErrors) / toolCalls).toFixed(4)),
      },
      generatedAt: nowIso(),
    }
  }

  /** Health payload for the same-origin health route. */
  health() {
    const snapshot = this.snapshot()
    const unusable = snapshot.servers.filter((item) => item.state === STATES.error)
    return {
      ok: snapshot.config.enabled ? unusable.length === 0 || snapshot.servers.some((item) => TERMINAL_OK.has(item.state)) : true,
      enabled: snapshot.config.enabled,
      servers: snapshot.stats.total,
      ready: snapshot.stats.ready,
      degraded: snapshot.stats.degraded,
      errored: snapshot.stats.error,
      disabled: snapshot.stats.disabled,
      tools: snapshot.stats.tools,
      toolCalls: snapshot.stats.toolCalls,
      toolErrors: snapshot.stats.toolErrors,
      uptimeMs: snapshot.stats.uptimeMs,
      states: Object.fromEntries(snapshot.servers.map((item) => [item.serverName, item.state])),
    }
  }

  /**
   * Add one server: validate, persist, then connect that entry only.
   * @param payload - `{ serverName, config, disabled }`.
   * @returns `{ receipt, server }`.
   */
  async addServer(payload) {
    this.#assertUsable()
    const { entry, issues } = normalizeDraft(payload, { allowedTransports: this.config.allowedTransports })
    if (entry === undefined) throw issueToDiagnostic(issues)
    if (this.#store.nameTaken(entry.serverName)) {
      throw new McpDiagnostic(CODES.SERVER_NAME_CONFLICT, PHASES.config, `serverName "${entry.serverName}" 已被占用；改名请走「删除后重建」`, {
        serverName: entry.serverName,
      })
    }
    const record = await this.#store.insert({
      serverName: entry.serverName,
      config: entry.config,
      disabled: entry.disabled,
      source: 'manual',
    })
    const server = this.#createServer(record)
    this.#servers.set(record.id, server)
    if (record.disabled || !this.config.enabled || !this.config.registry.enabled) {
      server.state = STATES.disabled
      this.#emit('added', { id: record.id, serverName: record.serverName, state: server.state })
    } else {
      await this.connect(server).catch(() => {})
    }
    return {
      receipt: this.#receipt('add', server, '已添加服务器；连接结果见状态'),
      server: this.#present(server),
      warnings: issues.filter((item) => item.level === 'warning'),
    }
  }

  /**
   * Edit one server's connection parameters. `serverName` is immutable.
   * The connection is swapped in place; nothing else is touched.
   */
  async updateServer(id, payload) {
    this.#assertUsable()
    const server = this.#requireServer(id)
    const patch = payload ?? {}
    const requested = patch.serverName === undefined ? server.record.serverName : String(patch.serverName).trim()
    if (requested !== server.record.serverName && this.#store.nameTaken(requested, id)) {
      throw new McpDiagnostic(
        CODES.SERVER_NAME_CONFLICT,
        PHASES.config,
        `serverName "${requested}" 已被占用；换一个名字`,
        { current: server.record.serverName, requested },
      )
    }
    const { entry, issues } = normalizeDraft(
      { serverName: requested, config: patch.config ?? patch, disabled: patch.disabled ?? server.record.disabled },
      { allowedTransports: this.config.allowedTransports },
    )
    if (entry === undefined) throw issueToDiagnostic(issues)
    // Renaming swaps the tool prefix, so tear the old generation down first.
    if (entry.serverName !== server.record.serverName) await this.#teardown(server)
    const renamed = entry.serverName !== server.record.serverName
    const record = await this.#store.update(id, {
      serverName: entry.serverName,
      config: entry.config,
      disabled: entry.disabled,
    })
    server.record = record
    await this.#reconcile(server)
    return {
      receipt: this.#receipt('update', server, renamed ? '已更新并改名；工具已按新前缀重新注册' : '已更新；连接按需热更新'),
      server: this.#present(server),
      warnings: issues.filter((item) => item.level === 'warning'),
    }
  }

  /** Delete one server and release its connection + tools. */
  async removeServer(id) {
    this.#assertUsable()
    const server = this.#requireServer(id)
    const name = server.record.serverName
    await this.#teardown(server)
    this.#servers.delete(id)
    await this.#store.remove(id)
    this.#emit('removed', { id, serverName: name })
    return { receipt: { action: 'remove', at: nowIso(), id, serverName: name, message: `已删除 ${name}，其工具已注销` } }
  }

  /** Enable or disable one server; disabling keeps its config. */
  async setDisabled(id, disabled) {
    this.#assertUsable()
    const server = this.#requireServer(id)
    const record = await this.#store.update(id, { disabled: Boolean(disabled) })
    server.record = record
    await this.#reconcile(server)
    return {
      receipt: this.#receipt(disabled ? 'disable' : 'enable', server, disabled ? '已禁用：连接断开，配置保留' : '已启用：正在连接'),
      server: this.#present(server),
    }
  }

  /** Retry exactly one server, leaving every other connection alone. */
  async retryServer(id) {
    this.#assertUsable()
    const server = this.#requireServer(id)
    if (server.record.disabled) {
      throw new McpDiagnostic(CODES.DISABLED, PHASES.config, `${server.record.serverName} 已禁用，先启用再重试`, { id })
    }
    server.outageAttempts = 0
    await this.#teardown(server, { keepTools: true })
    await this.connect(server)
    return {
      receipt: this.#receipt('retry', server, server.state === STATES.error ? '重试失败，见诊断' : '已重试该连接'),
      server: this.#present(server),
    }
  }

  /** Re-run `tools/list` for one live server. */
  async refreshServer(id) {
    this.#assertUsable()
    const server = this.#requireServer(id)
    if (!server.connection || !server.connection.ready) {
      throw new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.tools, `${server.record.serverName} 未连接，无法刷新工具`, { id })
    }
    const tools = await server.connection.refreshTools()
    this.#syncTools(server, tools)
    return { receipt: this.#receipt('refresh', server, `工具列表已刷新（${tools.length} 个）`), server: this.#present(server) }
  }

  /**
   * Pre-flight probe with draft parameters.
   *
   * Persists nothing, touches no live connection, and never issues `tools/call`.
   * A probe failure is a *result*, not an exception: the page shows both a
   * failing probe and a successful mount as separate facts.
   */
  async testConnection(payload) {
    // Two callers: the editor posts `{ serverName, config }` (a draft), the list
    // row posts `{ id }` (probe the saved config). Treating the whole `{ id }`
    // payload as a draft is what produced CONFIG_INVALID "no transport" — an id is
    // not a connection body.
    let draft = payload?.config
    let serverName = payload?.serverName
    if (payload?.id !== undefined) {
      const server = this.#requireServer(String(payload.id))
      draft = draft ?? server.record.config
      serverName = serverName ?? server.record.serverName
    } else if (draft === undefined) {
      // A flat draft: connection fields at the top level.
      draft = payload
    }
    const { entry, issues } = normalizeDraft(
      { serverName: serverName ?? 'probe', config: draft },
      { allowedTransports: this.config.allowedTransports },
    )
    if (entry === undefined) {
      return {
        ok: false,
        elapsedMs: 0,
        error: issueToDiagnostic(issues).toJSON(),
        warnings: issues.filter((item) => item.level === 'warning'),
      }
    }
    let resolved
    try {
      resolved = await resolveCredentials(entry.config, { resolve: (ref) => this.#resolveSecret(ref) })
    } catch (error) {
      // An unresolved credential is a probe result, not an exception: the page
      // must show "configure this credential" instead of a fake network failure.
      return {
        ok: false,
        elapsedMs: 0,
        error: asDiagnostic(error, CODES.CREDENTIAL_MISSING, PHASES.config).toJSON(),
        warnings: issues.filter((item) => item.level === 'warning'),
      }
    }
    const result = await probeConnection(resolved, {
      timeoutMs: this.config.probeTimeoutMs,
      maxStderrLines: this.config.maxStderrLines,
      label: `mcp-probe(${entry.serverName})`,
    })
    return { ...result, warnings: [...(result.warnings ?? []), ...issues.filter((item) => item.level === 'warning')] }
  }

  /**
   * Credential references used by one server, with resolved/!resolved status.
   * Values never leave the provider.
   *
   * @param id - server id; omit for every server.
   */
  async credentialStatus(id) {
    const credentials = this.ctx?.get?.('credentials')
    const describe = credentials?.describe ? (ref) => credentials.describe(ref) : undefined
    const servers = id === undefined
      ? [...this.#servers.values()]
      : [this.#requireServer(id)]
    const output = []
    for (const server of servers) {
      output.push({
        id: server.record.id,
        serverName: server.record.serverName,
        refs: await describeCredentials(server.record.config, { describe }),
      })
    }
    return output
  }

  /**
   * Store a credential in the provider (DSH credentials service).
   *
   * @param ref - credential reference name.
   * @param value - the secret; never persisted in the registry.
   */
  async putCredential(ref, value) {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(ref)) {
      throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, '凭据引用名需匹配 [A-Za-z0-9_.:-]{1,64}', { ref })
    }
    if (typeof value !== 'string' || value === '') {
      throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, '凭据值不能为空', { ref })
    }
    const credentials = this.ctx?.get?.('credentials')
    if (credentials?.set) {
      try {
        await credentials.set(ref, value)
      } catch (error) {
        this.logger?.warn?.(`[mcp-connector] 平台凭据服务写入失败，改用本地凭据文件：${error.message}`)
      }
    }
    // Always keep a copy on disk: the platform service is memory-only in some
    // builds, and a lost token surfaced as CREDENTIAL_MISSING after a restart.
    await this.#credentialsFile.set(ref, value)
    return { ref, stored: true }
  }

  /** Remove a stored credential (environment fallbacks then apply again). */
  async unsetCredential(ref) {
    const credentials = this.ctx?.get?.('credentials')
    if (credentials?.unset) {
      try {
        await credentials.unset(ref)
      } catch {
        // the local copy is authoritative enough for the next connect
      }
    }
    await this.#credentialsFile.unset(ref)
    return { ref, unset: true }
  }

  /**
   * Import a JSON document (text or parsed) into the registry.
   *
   * @param payload.text - raw JSON text, or `document` - an already-parsed value.
   * @param payload.mode - `merge` (default) or `replace` (atomic full overwrite).
   * @returns `{ ok, dialect, accepted, rejected, receipt }` — nothing is written
   *   when any row fails validation.
   */
  async importJson(payload) {
    this.#assertUsable()
    let document = payload?.document
    if (document === undefined) {
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (text.trim() === '') {
        throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, '导入内容为空')
      }
      try {
        document = JSON.parse(text)
      } catch (error) {
        throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, `不是合法 JSON：${error?.message ?? error}`)
      }
    }
    const { dialect, accepted, rejected } = normalizeImport(document)
    if (accepted.length === 0 && rejected.length === 0) {
      throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, '导入内容里没有任何服务器条目', { dialect })
    }
    if (rejected.length > 0) {
      return {
        ok: false,
        written: false,
        dialect,
        accepted: accepted.map((entry) => entry.serverName),
        rejected,
        message: `${rejected.length} 条未通过校验，本次没有写入任何条目`,
      }
    }
    const mode = payload?.mode === 'replace' ? 'replace' : 'merge'
    const result = await this.#store.applyBatch({
      upsert: accepted.map((entry) => ({ serverName: entry.serverName, config: entry.config, disabled: entry.disabled })),
      remove: [],
      replace: mode === 'replace',
    })
    await this.#reconcileAll()
    return {
      ok: true,
      written: true,
      mode,
      dialect,
      accepted: accepted.map((entry) => entry.serverName),
      rejected: [],
      receipt: {
        action: 'import',
        at: nowIso(),
        message: `${mode === 'replace' ? '全量覆盖' : '合并导入'}完成：新增 ${result.added.length}、更新 ${result.updated.length}、删除 ${result.removed.length}`,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
      },
    }
  }

  /** Export the registry in one of the three accepted shapes. */
  exportJson({ format = 'mcpServers' } = {}) {
    const entries = this.#store.list().map((record) => ({ serverName: record.serverName, config: record.config, disabled: record.disabled }))
    return {
      format,
      count: entries.length,
      document: exportEntries(entries, format),
    }
  }

  /**
   * Open (or reopen) one server's connection.
   *
   * Never throws for connection problems: they land in the server's state and
   * `lastError`, and possibly in a scheduled reconnect.
   */
  async connect(server) {
    if (this.#disposed) return
    if (!this.config.enabled || !this.config.registry.enabled) {
      this.#setState(server, STATES.disabled)
      return
    }
    if (server.record.disabled) {
      this.#setState(server, STATES.disabled)
      return
    }
    const generation = ++server.generation
    this.#clearReconnect(server)
    this.#setState(server, server.outageAttempts > 0 ? STATES.reconnecting : STATES.connecting)
    server.attempts += 1
    let connection
    try {
      // Resolve `${credential:REF}` placeholders per attempt: a rotated secret
      // applies on the next reconnect without touching the stored config, and a
      // missing one fails here as CREDENTIAL_MISSING instead of a 401.
      const resolved = await resolveCredentials(server.record.config, {
        resolve: (ref) => this.#resolveSecret(ref),
      })
      if (server.record.config.transport !== 'stdio') {
        const token = await this.#oauthToken(server)
        if (token) {
          resolved.headers = { ...(resolved.headers ?? {}), Authorization: `Bearer ${token}` }
        } else if (server.oauth.status === 'error') {
          throw new McpDiagnostic(CODES.OAUTH_REQUIRED, PHASES.auth, '授权已失效，请在服务器卡片上重新授权')
        }
      }
      connection = new McpConnection({
        config: resolved,
        timeoutMs: this.config.defaultTimeoutMs,
        toolCallTimeoutMs: server.record.config.toolCallTimeoutMs ?? this.config.toolCallTimeoutMs,
        maxStderrLines: this.config.maxStderrLines,
        label: `mcp(${server.record.serverName})`,
        callbacks: {
          onPhase: (phase) => {
            if (generation !== server.generation) return
            if (phase === PHASES.handshake || phase === PHASES.tools) this.#setState(server, STATES.initializing, { silent: true })
          },
          onClose: (diagnostic) => this.#onUnexpectedClose(server, generation, diagnostic),
          onToolsChanged: (tools) => {
            if (generation !== server.generation) return
            this.#syncTools(server, tools)
            this.#emit('tools', { id: server.record.id, serverName: server.record.serverName, toolCount: tools.length })
          },
        },
      })
      server.connection = connection
      const facts = await connection.connect()
      if (generation !== server.generation || this.#disposed) {
        await connection.close()
        return
      }
      server.protocolVersion = facts.protocolVersion
      server.revision = facts.revision
      server.capabilities = facts.capabilities
      server.serverInfo = facts.serverInfo
      server.transport = facts.transport
      server.notes = [...(facts.notes ?? [])]
      server.lastSuccessAt = nowIso()
      server.connectedAt = Date.now()
      server.lastError = null
      const reconnected = server.outageAttempts > 0
      server.outageAttempts = 0
      server.reconnects += reconnected ? 1 : 0
      this.#syncTools(server, facts.tools)
      const degraded = server.toolConflict !== undefined
        || facts.revision.known === false
        || facts.capabilities.tools === undefined
      this.#setState(server, degraded ? STATES.degraded : STATES.ready)
      this.logger.info?.(
        `[mcp-connector] ${server.record.serverName} 已连接：${facts.protocolVersion}，`
        + `${facts.tools.length} 个工具，传输 ${facts.transport.type}`,
      )
    } catch (error) {
      if (generation !== server.generation || this.#disposed) return
      const diagnostic = asDiagnostic(error, CODES.TRANSPORT_CLOSED, PHASES.transport)
      server.lastError = presentDiagnostic(diagnostic)
      server.connection = null
      // A connection object may exist when the failure came from the handshake
      // rather than from credential resolution.
      try {
        await connection?.close()
      } catch {
        // best effort
      }
      this.#setState(server, STATES.error)
      this.logger.warn?.(`[mcp-connector] ${server.record.serverName} 连接失败：${diagnostic.code}/${diagnostic.phase} ${diagnostic.message}`)
      this.#scheduleReconnect(server)
    }
  }

  /** Release every connection, timer and tool registration. */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    const servers = [...this.#servers.values()].reverse()
    for (const server of servers) {
      this.#clearReconnect(server)
      server.generation += 1
      disposeTools(server.toolDisposers)
      server.toolDisposers = []
      try {
        await server.connection?.close()
      } catch {
        // best effort
      }
      server.connection = null
    }
    this.#servers.clear()
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #assertUsable() {
    if (!this.config.registry.enabled) {
      throw new McpDiagnostic(CODES.DISABLED, PHASES.config, '运行时注册表已在部署配置中关闭（registry.enabled=false）')
    }
  }

  #requireServer(id) {
    const server = this.#servers.get(id)
    if (!server) throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, `找不到服务器 ${id}`, { id })
    return server
  }

  /**
   * Resolve one credential reference: DSH credentials first, then an environment
   * variable of the same name (the documented fallback for deployments without a
   * credential provider).
   */
  async #resolveSecret(ref) {
    const credentials = this.ctx?.get?.('credentials')
    if (credentials?.resolve) {
      try {
        const hit = await credentials.resolve(ref)
        if (typeof hit?.value === 'string' && hit.value !== '') return hit.value
      } catch {
        // fall through to the environment
      }
    }
    const fromFile = await this.#credentialsFile.get(ref)
    if (fromFile !== undefined) return fromFile
    const fromEnv = process.env?.[ref]
    return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
  }

  #createServer(record) {
    return {
      record,
      state: STATES.draft,
      connection: null,
      toolDisposers: [],
      tools: [],
      toolConflict: undefined,
      protocolVersion: null,
      revision: null,
      capabilities: null,
      serverInfo: null,
      transport: null,
      notes: [],
      lastError: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      connectedAt: null,
      generation: 0,
      attempts: 0,
      reconnects: 0,
      toolCalls: 0,
      toolErrors: 0,
      outageAttempts: 0,
      reconnectTimer: null,
      reconnectAt: null,
      oauth: {
        status: 'none',
        clientId: null,
        clientSecret: null,
        metadata: null,
        resource: null,
        tokens: null,
        pending: null,
        error: null,
      },
    }
  }

  /** Credential references holding this server's OAuth tokens. */
  #oauthRefs(server) {
    const name = String(server.record.serverName ?? 'SERVER')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
    const prefix = `MCP_OAUTH_${name || 'SERVER'}_`
    return { access: `${prefix}ACCESS`, refresh: `${prefix}REFRESH`, meta: `${prefix}META` }
  }

  async #writeOAuthSecret(ref, value) {
    const credentials = this.ctx?.get?.('credentials')
    if (credentials?.set) {
      await credentials.set(ref, value)
      return true
    }
    return false
  }

  async #clearOAuthSecret(ref) {
    const credentials = this.ctx?.get?.('credentials')
    if (credentials?.unset) {
      try {
        await credentials.unset(ref)
      } catch {
        // best effort
      }
    }
  }

  /** Access token for the next request, refreshed when it is close to expiry. */
  async #oauthToken(server) {
    const oauth = server.oauth
    if (oauth.status !== 'authorized' || !oauth.tokens) return undefined
    const skewMs = 60_000
    if (oauth.tokens.expiresAt && oauth.tokens.expiresAt - Date.now() > skewMs) return oauth.tokens.accessToken
    if (!oauth.tokens.refreshToken) return oauth.tokens.accessToken
    const refreshed = await this.#refreshOAuth(server)
    return refreshed
  }

  async #refreshOAuth(server) {
    const oauth = server.oauth
    if (!oauth.tokens?.refreshToken || !oauth.metadata) return undefined
    try {
      const body = await refreshAccessToken({
        metadata: oauth.metadata,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        refreshToken: oauth.tokens.refreshToken,
        resource: oauth.resource,
      })
      await this.#storeOAuthTokens(server, body)
      return server.oauth.tokens.accessToken
    } catch (error) {
      server.oauth.status = 'error'
      server.oauth.error = {
        code: error?.code ?? 'OAUTH_REFRESH_FAILED',
        phase: 'auth',
        message: error?.message ?? String(error),
      }
      this.#emit('oauth', { id: server.record.id, serverName: server.record.serverName, status: server.oauth.status })
      return undefined
    }
  }

  async #storeOAuthTokens(server, body) {
    const refs = this.#oauthRefs(server)
    const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : server.oauth.tokens?.refreshToken
    const expiresIn = Number(body.expires_in)
    const tokens = {
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    }
    server.oauth.tokens = tokens
    server.oauth.status = 'authorized'
    server.oauth.error = null
    await this.#writeOAuthSecret(refs.access, accessToken)
    if (refreshToken) await this.#writeOAuthSecret(refs.refresh, refreshToken)
    await this.#writeOAuthSecret(refs.meta, JSON.stringify({
      clientId: server.oauth.clientId,
      clientSecret: server.oauth.clientSecret,
      resource: server.oauth.resource,
      metadata: server.oauth.metadata,
    }))
  }

  /** Restore tokens persisted by an earlier run. */
  async #restoreOAuth(server) {
    const refs = this.#oauthRefs(server)
    const accessToken = await this.#resolveSecret(refs.access)
    if (!accessToken) return
    const refreshToken = await this.#resolveSecret(refs.refresh)
    let meta = null
    const raw = await this.#resolveSecret(refs.meta)
    if (typeof raw === 'string') {
      try {
        meta = JSON.parse(raw)
      } catch {
        meta = null
      }
    }
    server.oauth.tokens = { accessToken, refreshToken, expiresAt: null, tokenType: 'Bearer' }
    server.oauth.clientId = meta?.clientId ?? null
    server.oauth.clientSecret = meta?.clientSecret ?? null
    server.oauth.metadata = meta?.metadata ?? null
    server.oauth.resource = meta?.resource ?? null
    server.oauth.status = 'authorized'
  }

  /**
   * Start the authorization-code flow for one server.
   * @returns `{ url, redirectUri }` — the caller opens the URL in a browser.
   */
  async beginOAuth(id) {
    const server = this.#servers.get(id)
    if (!server) throw new McpDiagnostic(CODES.SERVER_NOT_FOUND, PHASES.config, '服务器不存在')
    const url = server.record.config?.url
    if (typeof url !== 'string' || url === '') {
      throw new McpDiagnostic(CODES.CONFIG_INVALID, PHASES.config, '只有 HTTP 传输的服务器支持 OAuth 授权')
    }
    if (server.oauth.status === 'pending') {
      throw new McpDiagnostic(CODES.OAUTH_FAILED, PHASES.auth, '已有一个授权流程在等待浏览器回调')
    }

    const resource = await discoverProtectedResource(url)
    const issuer = resource?.authorizationServers?.[0]
    const metadata = issuer ? await discoverAuthorizationServer(issuer) : null
    if (!metadata) {
      throw new McpDiagnostic(
        CODES.OAUTH_UNSUPPORTED,
        PHASES.auth,
        '该服务器没有公开 OAuth 元数据，无法发起授权（可能不需要授权，或只支持静态令牌）',
      )
    }

    const loopback = await startLoopbackServer({ timeoutMs: 5 * 60 * 1000 })
    let clientId = server.oauth.clientId ?? null
    if (!clientId) {
      const registered = await registerClient(metadata, { redirectUri: loopback.redirectUri })
      if (registered?.error) {
        loopback.close()
        const reason = registered.error === 'forbidden'
          ? '注册被拒绝（HTTP 403）：该服务只允许白名单客户端接入，无法用本插件授权'
          : registered.error === 'rejected'
            ? `注册被拒绝（HTTP ${registered.status ?? '?'}）`
            : '授权服务器没有提供动态客户端注册，需要手工提供 client_id'
        throw new McpDiagnostic(CODES.OAUTH_UNSUPPORTED, PHASES.auth, reason)
      }
      clientId = registered.clientId
      server.oauth.clientSecret = registered.clientSecret ?? null
    }

    const { verifier, challenge } = createPkce()
    const state = createState()
    const target = resource?.resource ?? url
    const authorizeUrl = buildAuthorizeUrl({
      metadata,
      clientId,
      redirectUri: loopback.redirectUri,
      state,
      challenge,
      resource: target,
    })

    server.oauth.status = 'pending'
    server.oauth.error = null
    server.oauth.clientId = clientId
    server.oauth.metadata = metadata
    server.oauth.resource = target
    server.oauth.pending = { verifier, state, redirectUri: loopback.redirectUri }

    loopback.waitForCode().then(async ({ code, state: returned }) => {
      if (returned !== server.oauth.pending?.state) {
        throw Object.assign(new Error('授权回调的 state 不匹配'), { code: 'OAUTH_STATE_MISMATCH' })
      }
      const body = await exchangeCode({
        metadata: server.oauth.metadata,
        clientId: server.oauth.clientId,
        clientSecret: server.oauth.clientSecret,
        code,
        redirectUri: loopback.redirectUri,
        verifier,
        resource: server.oauth.resource,
      })
      server.oauth.pending = null
      await this.#storeOAuthTokens(server, body)
      this.#emit('oauth', { id: server.record.id, serverName: server.record.serverName, status: server.oauth.status })
      await this.connect(server).catch(() => {})
    }).catch((error) => {
      server.oauth.status = 'error'
      server.oauth.error = {
        code: error?.code ?? 'OAUTH_FAILED',
        phase: 'auth',
        message: error?.message ?? String(error),
      }
      server.oauth.pending = null
      this.#emit('oauth', { id: server.record.id, serverName: server.record.serverName, status: server.oauth.status })
    }).finally(() => {
      loopback.close()
    })

    this.#emit('oauth', { id: server.record.id, serverName: server.record.serverName, status: 'pending' })
    return { url: authorizeUrl, redirectUri: loopback.redirectUri }
  }

  /** Forget the tokens for one server. */
  async revokeOAuth(id) {
    const server = this.#servers.get(id)
    if (!server) throw new McpDiagnostic(CODES.SERVER_NOT_FOUND, PHASES.config, '服务器不存在')
    const refs = this.#oauthRefs(server)
    await this.#clearOAuthSecret(refs.access)
    await this.#clearOAuthSecret(refs.refresh)
    await this.#clearOAuthSecret(refs.meta)
    server.oauth = { status: 'none', clientId: null, metadata: null, resource: null, tokens: null, pending: null, error: null }
    this.#emit('oauth', { id: server.record.id, serverName: server.record.serverName, status: 'none' })
    await this.#reconcile(server)
    return this.#present(server)
  }

  /** Reconnect / disconnect one server after its persisted record changed. */
  async #reconcile(server) {
    if (server.record.disabled || !this.config.enabled || !this.config.registry.enabled) {
      await this.#teardown(server)
      this.#setState(server, STATES.disabled)
      return
    }
    await this.#teardown(server, { keepTools: false })
    server.outageAttempts = 0
    await this.connect(server)
  }

  /** Reconcile every server after a bulk write. */
  async #reconcileAll() {
    const records = this.#store.list()
    const seen = new Set(records.map((record) => record.id))
    for (const [id, server] of [...this.#servers.entries()]) {
      if (seen.has(id)) continue
      await this.#teardown(server)
      this.#servers.delete(id)
    }
    for (const record of records) {
      const existing = this.#servers.get(record.id)
      if (existing === undefined) {
        const server = this.#createServer(record)
        this.#servers.set(record.id, server)
        if (!record.disabled && this.config.enabled) await this.connect(server).catch(() => {})
        continue
      }
      const changed = JSON.stringify(existing.record.config) !== JSON.stringify(record.config)
        || existing.record.disabled !== record.disabled
      existing.record = record
      if (!changed) continue
      await this.#reconcile(existing)
    }
  }

  /** Dispose the connection (and optionally tools) but keep the server entry. */
  async #teardown(server, { keepTools = false } = {}) {
    this.#clearReconnect(server)
    server.generation += 1
    if (!keepTools) {
      disposeTools(server.toolDisposers)
      server.toolDisposers = []
      server.tools = []
    }
    const connection = server.connection
    server.connection = null
    if (connection) {
      try {
        await connection.close()
      } catch {
        // best effort
      }
    }
  }

  /** Unexpected transport closure (not owner-initiated): mark and maybe retry. */
  #onUnexpectedClose(server, generation, diagnostic) {
    if (this.#disposed || generation !== server.generation) return
    const presented = presentDiagnostic(diagnostic)
    server.lastError = presented
    server.lastErrorAt = presented.at
    server.connection = null
    disposeTools(server.toolDisposers)
    server.toolDisposers = []
    server.tools = []
    this.#setState(server, STATES.error)
    this.logger.warn?.(`[mcp-connector] ${server.record.serverName} 连接断开：${diagnostic?.code ?? 'UNKNOWN'} ${diagnostic?.message ?? ''}`)
    this.#scheduleReconnect(server)
  }

  /** Register the current tool generation and swap the previous one out. */
  #syncTools(server, tools) {
    server.tools = tools.map((tool) => ({
      name: tool.name,
      publicName: publicToolName(server.record.serverName, tool.name),
      description: tool.description ?? '',
    }))
    if (!this.config.exposeTools) {
      server.notes = [...new Set([...server.notes, '部署配置关闭了工具暴露（exposeTools=false）'])]
      return
    }
    const { disposers, names, conflict } = registerServerTools(this.ctx, {
      serverName: server.record.serverName,
      tools,
      previous: server.toolDisposers,
      label: `mcp(${server.record.serverName})`,
      call: async (tool, args, signal) => {
        const connection = server.connection
        if (!connection || !connection.ready) {
          throw new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.call, `${server.record.serverName} 当前未连接`)
        }
        server.toolCalls += 1
        try {
          return await connection.callTool(tool.name, args, { signal })
        } catch (error) {
          server.toolErrors += 1
          throw error
        }
      },
    })
    server.toolDisposers = disposers
    server.registeredToolNames = names
    server.toolConflict = conflict
    if (conflict) {
      server.notes = [...new Set([...server.notes, `工具注册冲突：${conflict.message}`])]
      this.logger.error?.(`[mcp-connector] ${server.record.serverName}: ${conflict.message}`)
    }
  }

  #scheduleReconnect(server) {
    if (!this.config.reconnect.enabled || !this.config.enabled) return
    if (server.record.disabled) return
    // A bad token or a missing authorization never fixes itself by retrying.
    const terminal = new Set(['HTTP_AUTH', 'CREDENTIAL_MISSING', 'CREDENTIAL_UNAVAILABLE', 'OAUTH_REQUIRED', 'CONFIG_INVALID'])
    if (terminal.has(server.lastError?.code)) {
      this.logger.info?.(`[mcp-connector] ${server.record.serverName} 需要人工处理（${server.lastError.code}），已停止自动重连`)
      return
    }
    server.outageAttempts += 1
    if (server.outageAttempts > this.config.reconnect.maxAttempts) {
      server.notes = [...new Set([...server.notes, `已停止重连：连续 ${this.config.reconnect.maxAttempts} 次失败`])]
      this.logger.warn?.(`[mcp-connector] ${server.record.serverName} 重连次数用尽，等待手动重试`)
      return
    }
    const delay = Math.min(
      this.config.reconnect.maxDelayMs,
      this.config.reconnect.initialDelayMs * 2 ** (server.outageAttempts - 1),
    )
    this.#clearReconnect(server)
    server.reconnectAt = new Date(Date.now() + delay).toISOString()
    const timer = setTimeout(() => {
      server.reconnectTimer = null
      server.reconnectAt = null
      this.connect(server).catch(() => {})
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    server.reconnectTimer = timer
    this.#setState(server, STATES.reconnecting)
  }

  #clearReconnect(server) {
    if (server.reconnectTimer) {
      clearTimeout(server.reconnectTimer)
      server.reconnectTimer = null
    }
    server.reconnectAt = null
  }

  #setState(server, state, { silent = false } = {}) {
    const changed = server.state !== state
    server.state = state
    if (!changed || silent) return
    this.#emit('state', {
      id: server.record.id,
      serverName: server.record.serverName,
      state,
      lastError: server.lastError,
    })
  }

  #emit(type, payload) {
    const event = { type, ...payload, at: nowIso() }
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // a broken subscriber must not break the runtime
      }
    }
    try {
      this.ctx?.emit?.(`mcp-connector/${type}`, event)
    } catch {
      // `ctx.emit` is optional: the page reads state over HTTP.
    }
  }

  #receipt(action, server, message) {
    return {
      action,
      at: nowIso(),
      id: server.record.id,
      serverName: server.record.serverName,
      state: server.state,
      message,
    }
  }

  /** The UI-facing projection of one server. */
  #present(server) {
    const stored = server.record
    const config = describeEntry({ serverName: stored.serverName, config: stored.config })
    return {
      id: stored.id,
      serverName: stored.serverName,
      disabled: Boolean(stored.disabled),
      state: server.state,
      stateLabel: STATE_LABELS[server.state] ?? server.state,
      config,
      transport: server.transport ?? { type: stored.config.transport },
      protocolVersion: server.protocolVersion,
      revision: server.revision ?? null,
      capabilities: server.capabilities === null ? null : Object.keys(server.capabilities ?? {}),
      serverInfo: server.serverInfo,
      tools: server.tools,
      toolCount: server.tools.length,
      notes: [...server.notes],
      lastError: server.lastError,
      lastSuccessAt: server.lastSuccessAt,
      lastErrorAt: server.lastErrorAt,
      reconnectAt: server.reconnectAt,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      source: stored.source,
      stats: {
        attempts: server.attempts,
        reconnects: server.reconnects,
        toolCalls: server.toolCalls,
        toolErrors: server.toolErrors,
        connectedAt: server.connectedAt,
        uptimeMs: server.connectedAt === null ? 0 : Date.now() - server.connectedAt,
      },
      credentials: stored.config.transport === 'stdio'
        ? { envKeys: Object.keys(stored.config.env ?? {}) }
        : { headerNames: Object.keys(stored.config.headers ?? {}) },
      credentialRefs: collectCredentialRefs(stored.config),
      oauth: {
        status: server.oauth.status,
        authorized: server.oauth.status === 'authorized',
        clientId: server.oauth.clientId,
        expiresAt: server.oauth.tokens?.expiresAt ?? null,
        error: server.oauth.error,
      },
    }
  }
}
