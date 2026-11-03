/**
 * JSON-RPC 2.0 peer: request correlation, timeouts, protocol-error
 * classification and notification dispatch.
 *
 * The peer is transport-agnostic: a transport hands it decoded messages and a
 * `send` function. That keeps the stdio and HTTP transports interchangeable and
 * lets a probe reuse the same code path as a live connection.
 */
import { CODES, McpDiagnostic, PHASES } from './diagnostics.js'

/** JSON-RPC error codes with a stable meaning per the MCP specification. */
const RPC_METHOD_NOT_FOUND = -32601
const RPC_INVALID_PARAMS = -32602
const RPC_INVALID_REQUEST = -32600
const RPC_PARSE_ERROR = -32700

/**
 * Map one JSON-RPC error body onto a diagnostic code.
 * @param response - the JSON-RPC error object.
 */
function classifyRpcError(response) {
  const code = response?.code
  const message = String(response?.message ?? 'JSON-RPC 错误')
  const data = response?.data
  if (code === RPC_METHOD_NOT_FOUND) return new McpDiagnostic(CODES.METHOD_NOT_FOUND, PHASES.handshake, `服务器不支持方法：${message}`, { rpcCode: code, data })
  if (code === RPC_INVALID_PARAMS) return new McpDiagnostic(CODES.INVALID_PARAMS, PHASES.handshake, `参数不合法：${message}`, { rpcCode: code, data })
  if (code === RPC_INVALID_REQUEST || code === RPC_PARSE_ERROR) {
    return new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.handshake, `JSON-RPC 请求非法：${message}`, { rpcCode: code, data })
  }
  return new McpDiagnostic(CODES.PROTOCOL_ERROR, PHASES.handshake, `服务器返回 JSON-RPC 错误：${message}`, { rpcCode: code, data })
}

/**
 * The phase a method belongs to, so a timeout or error is attributed correctly.
 * @param method - JSON-RPC method name.
 */
export function phaseOfMethod(method) {
  if (method === 'initialize') return PHASES.handshake
  if (method === 'notifications/initialized') return PHASES.handshake
  if (method.startsWith('tools/list')) return PHASES.tools
  if (method.startsWith('tools/call')) return PHASES.call
  if (method.startsWith('resources/') || method.startsWith('prompts/')) return PHASES.capabilities
  return PHASES.session
}

/**
 * A JSON-RPC 2.0 peer bound to one live transport.
 *
 * Lifecycle: `new` → (transport delivers messages) → `dispose()`. Every pending
 * request is rejected exactly once: by its own response, its timeout, an abort,
 * or transport closure.
 */
export class JsonRpcPeer {
  #nextId = 1
  #pending = new Map()
  #send
  #onNotification
  #onRequest
  #disposed = false
  #closeReason = null
  #label

  /**
   * @param options.send - write one message to the transport; returns void or a promise.
   * @param options.timeoutMs - default per-request timeout.
   * @param options.onNotification - `(method, params, meta)` for server notifications.
   * @param options.label - diagnostic prefix, e.g. `mcp(server)`.
   */
  constructor({ send, timeoutMs = 30_000, onNotification, onRequest, label = 'mcp' }) {
    this.#send = send
    this.timeoutMs = timeoutMs
    this.#onNotification = onNotification
    this.#onRequest = onRequest
    this.#label = label
  }

  /** Number of in-flight requests; used by diagnostics and tests. */
  get pendingCount() {
    return this.#pending.size
  }

  /** Whether the peer can still carry traffic. */
  get closed() {
    return this.#disposed
  }

  /** Why the peer closed, when it closed because of a transport failure. */
  get closeReason() {
    return this.#closeReason
  }

  /**
   * Issue a request and await its result.
   *
   * @param method - JSON-RPC method.
   * @param params - method params (omitted when undefined).
   * @param options.timeoutMs - override for this call.
   * @param options.signal - caller cancellation.
   * @param options.idle - `send` may resolve with a streaming response; ignored here.
   * @returns the JSON-RPC `result`.
   */
  request(method, params, options = {}) {
    if (this.#disposed) {
      return Promise.reject(this.#closeReason ?? new McpDiagnostic(CODES.TRANSPORT_CLOSED, phaseOfMethod(method), `${this.#label}: 连接已关闭`))
    }
    const id = this.#nextId++
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const phase = phaseOfMethod(method)
    const message = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    if (options.meta !== undefined) message.params = { ...(message.params ?? {}), _meta: options.meta }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(id, new McpDiagnostic(
          phase === PHASES.handshake ? CODES.HANDSHAKE_TIMEOUT : CODES.TIMEOUT,
          phase,
          `${this.#label}: ${method} 在 ${timeoutMs}ms 内没有响应`,
          { method, timeoutMs },
        ))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      const onAbort = () => this.#settle(id, new McpDiagnostic(CODES.ABORTED, phase, `${this.#label}: ${method} 已取消`, { method }))
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer)
          reject(new McpDiagnostic(CODES.ABORTED, phase, `${this.#label}: ${method} 已取消`, { method }))
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      this.#pending.set(id, {
        method,
        phase,
        resolve,
        reject,
        timer,
        signal: options.signal,
        onAbort,
      })

      try {
        const sent = this.#send(message)
        if (sent && typeof sent.catch === 'function') {
          sent.catch((error) => this.#settle(id, this.#sendFailure(error, method)))
        }
      } catch (error) {
        this.#settle(id, this.#sendFailure(error, method))
      }
    })
  }

  /**
   * Fire a notification (no id, no response expected).
   * @param method - JSON-RPC method.
   * @param params - optional params.
   */
  notify(method, params) {
    if (this.#disposed) return Promise.resolve()
    const message = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    return Promise.resolve(this.#send(message))
  }

  /**
   * Feed one decoded message from the transport.
   * @param message - parsed JSON-RPC message (request, response or notification).
   */
  accept(message) {
    if (this.#disposed) return
    if (message === null || typeof message !== 'object') {
      this.fail(new McpDiagnostic(CODES.INVALID_FRAME, PHASES.transport, `${this.#label}: 收到非 JSON-RPC 帧`, { sample: message }))
      return
    }
    // Response: correlate by id.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && message.method === undefined) {
      const entry = this.#pending.get(message.id)
      if (!entry) return
      if (message.error !== undefined) {
        const diagnostic = classifyRpcError(message.error)
        diagnostic.phase = entry.phase
        this.#settle(message.id, diagnostic)
        return
      }
      this.#settle(message.id, null, message.result)
      return
    }
    // Server-initiated request: we advertise no client capabilities, so decline.
    if (message.method !== undefined && message.id !== undefined) {
      const handled = this.#onRequest?.(message.method, message.params, message)
      const response = handled === true
        ? undefined
        : { jsonrpc: '2.0', id: message.id, error: { code: RPC_METHOD_NOT_FOUND, message: `client 未声明能力：${message.method}` } }
      if (response) {
        try {
          this.#send(response)
        } catch {
          // A declined server request must never break the session.
        }
      }
      return
    }
    // Notification.
    if (message.method !== undefined) {
      this.#onNotification?.(message.method, message.params, message)
      return
    }
    this.fail(new McpDiagnostic(CODES.INVALID_FRAME, PHASES.transport, `${this.#label}: 无法识别的 JSON-RPC 消息`, { message }))
  }

  /**
   * Tear the peer down: reject every pending request with `reason`.
   * @param reason - the diagnostic explaining the closure; idempotent.
   */
  fail(reason) {
    if (this.#disposed) return
    this.#disposed = true
    this.#closeReason = reason ?? null
    for (const [id, entry] of this.#pending) this.#settle(id, reason ?? this.#closedDiagnostic(entry))
  }

  /** Close politely, rejecting anything still in flight. */
  dispose(reason) {
    this.fail(reason ?? new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.transport, `${this.#label}: 连接已释放`))
  }

  #closedDiagnostic(entry) {
    return new McpDiagnostic(CODES.TRANSPORT_CLOSED, entry.phase, `${this.#label}: 连接已关闭`, { method: entry.method })
  }

  /**
   * Normalize a transport write failure.
   *
   * A transport that already classified the failure (HTTP 401, DNS, ...) must keep
   * its code and phase — re-wrapping it here would collapse every transport
   * problem into `TRANSPORT_CLOSED` and defeat the diagnostic taxonomy.
   */
  #sendFailure(error, method) {
    if (error instanceof McpDiagnostic) {
      if (error.detail?.method === undefined) error.detail = { ...error.detail, method }
      return error
    }
    return new McpDiagnostic(
      error?.code ?? CODES.TRANSPORT_CLOSED,
      PHASES.transport,
      `${this.#label}: 无法写入传输层：${error?.message ?? error}`,
      { method, cause: error?.message },
    )
  }

  #settle(id, diagnostic, result) {
    const entry = this.#pending.get(id)
    if (!entry) return
    this.#pending.delete(id)
    clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
    if (diagnostic) entry.reject(diagnostic)
    else entry.resolve(result)
  }
}

/** Whether a value is a plain object. */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
