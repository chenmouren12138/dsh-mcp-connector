/**
 * MCP session: transport + JSON-RPC peer + the lifecycle the specification
 * describes (initialize → capability negotiation → tools/list → tools/call).
 *
 * A connection is created for one server entry, is disposable, and never
 * outlives its owner: the registry disposes it on edit, delete, disable or
 * plugin unload. It reports progress through small callbacks so the registry can
 * drive the state machine without this module knowing about UI concerns.
 */
import { CODES, McpDiagnostic, PHASES } from './diagnostics.js'
import { JsonRpcPeer, isRecord } from './jsonrpc.js'
import { StdioTransport } from './transport-stdio.js'
import { StreamableHttpTransport } from './transport-http.js'

/**
 * Protocol revisions this client knows how to speak, newest first.
 *
 * The list is a *negotiation input*: the server answers with the revision it
 * will actually use, and {@link revisionProfile} decides which session semantics
 * apply. That keeps a 2025 session-oriented server and a later stateless-core
 * revision on one code path with an explicit branch instead of an assumption.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2026-06-18',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
])

export const CLIENT_INFO = Object.freeze({ name: 'dsh-mcp-connector', version: '1.0.0' })

/**
 * Which session semantics a negotiated revision uses.
 *
 * `stateless` revisions define the message exchange without a session: every
 * request stands alone and a missing `Mcp-Session-Id` is normal. `sessioned`
 * revisions may hand out a session id; losing it mid-flight is a session error.
 *
 * @param version - the revision the server answered with.
 */
export function revisionProfile(version) {
  if (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version)) return { known: false, kind: 'unknown' }
  const year = Number(version.slice(0, 4))
  const known = SUPPORTED_PROTOCOL_VERSIONS.includes(version)
  if (year >= 2026) return { known, kind: 'stateless' }
  return { known, kind: 'sessioned' }
}

/** Build the transport for one validated server config. */
export function createTransport(config, options) {
  if (config.transport === 'stdio') {
    return new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      maxStderrLines: options.maxStderrLines,
    })
  }
  return new StreamableHttpTransport({
    url: config.url,
    headers: config.headers,
    timeoutMs: options.timeoutMs,
    legacy: config.transport === 'sse',
  })
}

/**
 * One live MCP session.
 *
 * Usage: `new McpConnection(...)`, assign `callbacks`, then `connect()`. Every
 * public failure rejects with an {@link McpDiagnostic}.
 */
export class McpConnection {
  #transport = null
  #peer = null
  #disposed = false
  #closedPromise
  #resolveClosed
  #protocolVersion = null
  #serverCapabilities = {}
  #serverInfo = null
  #instructions = ''
  #tools = []

  /**
   * @param options.config - normalized server connection config (transport discriminated).
   * @param options.timeoutMs - handshake and discovery timeout.
   * @param options.toolCallTimeoutMs - per tools/call timeout.
   * @param options.maxStderrLines - stderr ring size for stdio servers.
   * @param options.label - diagnostic prefix.
   * @param options.callbacks - `{ onClose, onToolsChanged, onNotification }`.
   */
  constructor({ config, timeoutMs = 30_000, toolCallTimeoutMs = 60_000, maxStderrLines = 40, label = 'mcp', callbacks = {} }) {
    this.config = config
    this.timeoutMs = timeoutMs
    this.toolCallTimeoutMs = toolCallTimeoutMs
    this.maxStderrLines = maxStderrLines
    this.label = label
    this.callbacks = callbacks
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
  }

  /** Negotiated protocol revision, once `connect()` succeeded. */
  get protocolVersion() {
    return this.#protocolVersion
  }

  /** Server capabilities object from `initialize`. */
  get serverCapabilities() {
    return this.#serverCapabilities
  }

  /** Server identity from `initialize`. */
  get serverInfo() {
    return this.#serverInfo
  }

  /** Server instructions, if the server sent any. */
  get instructions() {
    return this.#instructions
  }

  /** Last discovered tool list. */
  get tools() {
    return this.#tools
  }

  /** Transport identity for diagnostics (url or command, never secrets). */
  describeTransport() {
    return this.#transport?.describe() ?? { type: this.config.transport }
  }

  /** stderr tail of a stdio server (redacted). */
  stderrTail() {
    return this.#transport?.stderrTail?.(this.maxStderrLines) ?? []
  }

  /** Resolves with the closing diagnostic (or `null` for an orderly close). */
  get closed() {
    return this.#closedPromise
  }

  /**
   * Establish the session: transport, `initialize`, capability negotiation,
   * `notifications/initialized`, then the first `tools/list`.
   *
   * @returns the negotiated facts: protocolVersion, capabilities, serverInfo, tools.
   */
  async connect() {
    const phase = { current: PHASES.transport }
    try {
      const transport = createTransport(this.config, {
        timeoutMs: this.timeoutMs,
        maxStderrLines: this.maxStderrLines,
      })
      this.#transport = transport
      transport.onmessage = (message) => this.#peer?.accept(message)
      transport.onclose = (diagnostic) => this.#handleClose(diagnostic)

      this.callbacks.onPhase?.(PHASES.transport)
      const identity = await transport.start()
      this.transportInfo = identity
      phase.current = PHASES.handshake
      this.callbacks.onPhase?.(PHASES.handshake)

      const peer = new JsonRpcPeer({
        send: (message) => (this.#transport ? this.#transport.send(message) : undefined),
        timeoutMs: this.timeoutMs,
        label: this.label,
        onNotification: (method, params) => this.#notify(method, params),
        onRequest: () => false,
      })
      this.#peer = peer

      const initResult = await peer.request('initialize', {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { roots: { listChanged: false } },
        clientInfo: CLIENT_INFO,
      })
      if (!isRecord(initResult)) {
        throw new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.handshake, 'initialize 返回的不是对象', { received: typeof initResult })
      }
      if (typeof initResult.protocolVersion !== 'string') {
        throw new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.handshake, 'initialize 缺少 protocolVersion', {
          keys: Object.keys(initResult),
        })
      }
      const profile = revisionProfile(initResult.protocolVersion)
      if (profile.kind === 'unknown') {
        throw new McpDiagnostic(
          CODES.PROTOCOL_INCOMPATIBLE,
          PHASES.handshake,
          `protocolVersion 格式非法：${String(initResult.protocolVersion)}`,
          { protocolVersion: String(initResult.protocolVersion) },
        )
      }
      this.#protocolVersion = initResult.protocolVersion
      this.#serverCapabilities = isRecord(initResult.capabilities) ? initResult.capabilities : {}
      this.#serverInfo = isRecord(initResult.serverInfo) ? initResult.serverInfo : null
      this.#instructions = typeof initResult.instructions === 'string' ? initResult.instructions : ''
      this.revision = profile
      this.#transport?.setProtocolVersion?.(initResult.protocolVersion)

      if (profile.kind === 'sessioned' && this.config.transport !== 'stdio' && !this.#transport?.sessionId) {
        // Not fatal: many sessioned servers answer statelessly for single requests.
        this.sessionNote = '服务器未下发 Mcp-Session-Id（会话无状态运行）'
      }
      if (this.config.transport !== 'stdio' && profile.kind === 'sessioned' && this.#transport?.sessionId) {
        this.sessionId = this.#transport.sessionId
      }

      await peer.notify('notifications/initialized')
      phase.current = PHASES.capabilities

      const capabilities = this.#serverCapabilities
      if (capabilities.tools === undefined) {
        this.capabilityNote = '服务器未声明 tools 能力，工具列表为空'
        this.#tools = []
      } else {
        phase.current = PHASES.tools
        this.callbacks.onPhase?.(PHASES.tools)
        this.#tools = await this.listAllTools()
      }

      this.ready = true
      return {
        protocolVersion: this.#protocolVersion,
        revision: this.revision,
        capabilities: this.#serverCapabilities,
        serverInfo: this.#serverInfo,
        instructions: this.#instructions,
        tools: this.#tools,
        transport: this.describeTransport(),
        sessionId: this.sessionId ? '存在' : '无',
        notes: [this.sessionNote, this.capabilityNote].filter(Boolean),
      }
    } catch (error) {
      const diagnostic = error instanceof McpDiagnostic
        ? error
        : new McpDiagnostic(error?.code ?? CODES.TRANSPORT_CLOSED, phase.current, error?.message ?? String(error), {})
      await this.close(diagnostic)
      throw diagnostic
    }
  }

  /**
   * `tools/list`, following `nextCursor` to the end.
   * @returns the merged tool list as declared by the server.
   */
  async listAllTools() {
    const tools = []
    let cursor
    for (let page = 0; page < 50; page += 1) {
      const result = await this.#peer.request('tools/list', cursor === undefined ? {} : { cursor }, {
        timeoutMs: this.timeoutMs,
      })
      if (!isRecord(result)) {
        throw new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.tools, 'tools/list 返回的不是对象', {})
      }
      const pageTools = Array.isArray(result.tools) ? result.tools : []
      for (const tool of pageTools) {
        if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name === '') {
          throw new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.tools, 'tools/list 中有工具缺少 name', { tool })
        }
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
          outputSchema: isRecord(tool.outputSchema) ? tool.outputSchema : undefined,
          annotations: isRecord(tool.annotations) ? tool.annotations : undefined,
        })
      }
      if (typeof result.nextCursor === 'string' && result.nextCursor !== '') {
        cursor = result.nextCursor
        continue
      }
      return tools
    }
    throw new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.tools, 'tools/list 分页超过 50 页，已中止', {})
  }

  /**
   * Refresh the tool list (used on `notifications/tools/list_changed`).
   * @returns the new list.
   */
  async refreshTools() {
    if (!this.ready) return this.#tools
    const tools = await this.listAllTools()
    this.#tools = tools
    return tools
  }

  /**
   * `tools/call`.
   *
   * Three failure classes stay distinguishable:
   * - protocol errors reject with a peer diagnostic (`PROTOCOL_ERROR`, ...);
   * - an `isError: true` result rejects with `TOOL_ERROR` carrying the text;
   * - a broken transport rejects with the transport diagnostic from the peer.
   *
   * @param rawName - the server's own tool name.
   * @param args - the arguments object.
   * @param options.signal - caller cancellation.
   * @returns the canonical `{ content, structuredContent? }` result.
   */
  async callTool(rawName, args, options = {}) {
    if (!this.ready) throw new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.call, '服务器尚未就绪')
    const result = await this.#peer.request('tools/call', { name: rawName, arguments: args ?? {} }, {
      timeoutMs: this.toolCallTimeoutMs,
      signal: options.signal,
    })
    if (!isRecord(result)) {
      throw new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.call, 'tools/call 返回的不是对象', { tool: rawName })
    }
    const content = Array.isArray(result.content) ? result.content : []
    if (result.isError === true) {
      const text = content
        .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      throw new McpDiagnostic(CODES.TOOL_ERROR, PHASES.call, text || `工具 ${rawName} 返回了错误`, {
        tool: rawName,
        content,
      })
    }
    return {
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    }
  }

  /**
   * Close the session and release the transport.
   * @param diagnostic - the reason to report to waiters; omit for an orderly close.
   */
  async close(diagnostic) {
    if (this.#disposed) return
    this.#disposed = true
    this.ready = false
    const reason = diagnostic ?? new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.transport, '连接已释放')
    this.#peer?.dispose(reason)
    this.#peer = null
    try {
      await this.#transport?.close()
    } catch {
      // A transport that cannot close cleanly must not block disposal.
    }
    this.#transport = null
    this.#resolveClosed(diagnostic ?? null)
    // Owner-initiated closes do not notify `onClose`: the caller already knows.
  }

  #handleClose(diagnostic) {
    if (this.#disposed) return
    this.ready = false
    this.#peer?.fail(diagnostic)
    this.#peer = null
    this.#disposed = true
    this.#resolveClosed(diagnostic)
    this.callbacks.onClose?.(diagnostic)
  }

  #notify(method, params) {
    if (method === 'notifications/tools/list_changed') {
      this.refreshTools()
        .then((tools) => this.callbacks.onToolsChanged?.(tools))
        .catch(() => {
          // A failed re-sync keeps the previous generation; the next successful
          // probe or reconnect refreshes it.
        })
      return
    }
    this.callbacks.onNotification?.(method, params)
  }
}

/**
 * One-shot pre-flight probe: connect with draft parameters, complete the
 * handshake and `tools/list`, then release everything.
 *
 * The probe never persists anything, never touches the runtime registry and never
 * issues `tools/call` — it is the positive evidence a user gets before saving.
 *
 * @param config - normalized draft config.
 * @param options.timeoutMs - independent probe timeout.
 * @returns the probe report (protocolVersion, capabilities, transport, tools).
 */
export async function probeConnection(config, { timeoutMs = 10_000, maxStderrLines = 40, label = 'mcp-probe' } = {}) {
  const connection = new McpConnection({
    config,
    timeoutMs,
    toolCallTimeoutMs: timeoutMs,
    maxStderrLines,
    label,
  })
  const startedAt = Date.now()
  try {
    const facts = await connection.connect()
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      protocolVersion: facts.protocolVersion,
      revision: facts.revision,
      capabilities: facts.capabilities,
      serverInfo: facts.serverInfo,
      instructions: facts.instructions ? facts.instructions.slice(0, 2000) : '',
      transport: facts.transport,
      sessionId: facts.sessionId,
      tools: facts.tools.map((tool) => ({
        name: tool.name,
        description: tool.description.slice(0, 280),
        hasInputSchema: Object.keys(tool.inputSchema ?? {}).length > 0,
      })),
      toolCount: facts.tools.length,
      notes: facts.notes,
      warnings: facts.tools.length === 0 ? ['tools/list 返回空列表：连接有效，但该服务器没有暴露任何工具'] : [],
    }
  } catch (error) {
    const diagnostic = error instanceof McpDiagnostic
      ? error
      : new McpDiagnostic(CODES.UNKNOWN, PHASES.transport, error?.message ?? String(error), {})
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: diagnostic.toJSON(),
      stderr: connection.stderrTail(),
    }
  } finally {
    await connection.close()
  }
}
