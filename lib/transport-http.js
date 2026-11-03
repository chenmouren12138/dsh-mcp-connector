/**
 * Streamable HTTP transport, with the legacy HTTP+SSE transport as a negotiated
 * fallback.
 *
 * Streamable HTTP (MCP 2025-03-26 and later): every JSON-RPC message is POSTed to
 * the server's single endpoint. The response is either `application/json` (one
 * message) or `text/event-stream` (a short-lived stream that may carry the reply
 * plus server notifications). `Mcp-Session-Id` is captured from the initialize
 * response and echoed on every later request, and `MCP-Protocol-Version` follows
 * the negotiated revision.
 *
 * HTTP+SSE (2024-11-05): a long-lived GET stream announces a `endpoint` event
 * naming the message URL; POSTs go there and replies arrive on the stream. Used
 * automatically when a server rejects the streamable POST with 404/405, so an old
 * server keeps working without the user reclassifying it.
 */
import { CODES, McpDiagnostic, PHASES, redactText } from './diagnostics.js'

const MCP_SESSION_HEADER = 'mcp-session-id'
const MCP_VERSION_HEADER = 'mcp-protocol-version'
const ACCEPT_STREAMABLE = 'application/json, text/event-stream'

/** Parse one SSE chunk buffer into complete events, returning the remainder. */
export function parseSseStream(buffer, onEvent) {
  let rest = buffer
  let boundary = rest.indexOf('\n\n')
  while (boundary >= 0) {
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    const event = { event: 'message', data: '', id: undefined }
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine.startsWith(':')) continue
      const colon = rawLine.indexOf(':')
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
      const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event.event = value
      else if (field === 'data') event.data += (event.data === '' ? '' : '\n') + value
      else if (field === 'id') event.id = value
    }
    if (event.data !== '' || event.event !== 'message') onEvent(event)
    boundary = rest.indexOf('\n\n')
  }
  return rest
}

/** Classify a fetch failure into a transport-phase diagnostic. */
function networkDiagnostic(error, url) {
  const cause = error?.cause
  const code = cause?.code ?? error?.code
  // undici refuses a set of "bad ports" before dialing; that is still a TCP-level
  // refusal as far as the user is concerned.
  const causeMessage = String(cause?.message ?? '')
  if (causeMessage.includes('bad port')) {
    return new McpDiagnostic(CODES.NETWORK_TCP, PHASES.transport, `该端口不被允许连接：${url}`, { code: 'BAD_PORT' })
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new McpDiagnostic(CODES.NETWORK_DNS, PHASES.transport, `域名解析失败：${url}`, { code })
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new McpDiagnostic(CODES.NETWORK_TCP, PHASES.transport, `无法建立 TCP 连接：${url}`, { code })
  }
  if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
    return new McpDiagnostic(CODES.NETWORK_TLS, PHASES.transport, `TLS 握手失败：${url}`, { code })
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new McpDiagnostic(CODES.HANDSHAKE_TIMEOUT, PHASES.handshake, `HTTP 请求超时：${url}`, { code })
  }
  return new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.transport, `HTTP 请求失败：${error?.message ?? error}`, {
    code,
    cause: cause?.message,
  })
}

/** Map an HTTP status onto the diagnostic vocabulary. */
function statusDiagnostic(status, url, body) {
  if (status === 401 || status === 403) {
    return new McpDiagnostic(CODES.HTTP_AUTH, PHASES.transport, `鉴权失败（HTTP ${status}）：检查 headers 中的凭据`, {
      status,
      url,
      body: body === undefined ? undefined : redactText(body.slice(0, 400)),
    })
  }
  if (status === 404) {
    return new McpDiagnostic(CODES.HTTP_NOT_FOUND, PHASES.transport, `端点不存在（HTTP 404）：${url}`, { status, url })
  }
  if (status >= 500) {
    return new McpDiagnostic(CODES.HTTP_SERVER_ERROR, PHASES.transport, `服务器错误（HTTP ${status}）`, {
      status,
      url,
      body: body === undefined ? undefined : redactText(body.slice(0, 400)),
    })
  }
  return new McpDiagnostic(CODES.HTTP_UNEXPECTED, PHASES.transport, `非预期的 HTTP 状态 ${status}`, {
    status,
    url,
    body: body === undefined ? undefined : redactText(body.slice(0, 400)),
  })
}

/**
 * A live Streamable HTTP (or legacy HTTP+SSE) transport.
 *
 * The connection assigns `onmessage` / `onclose`; `send` performs one HTTP
 * exchange and feeds every decoded message back through `onmessage`.
 */
export class StreamableHttpTransport {
  #sessionId = null
  #protocolVersion = null
  #closed = false
  #sseController = null
  #sseReady = null
  #messageUrl = null
  #streamBuffer = ''

  /**
   * @param options.url - the MCP endpoint.
   * @param options.headers - declared request headers (auth, tenant, ...).
   * @param options.timeoutMs - per-exchange timeout.
   * @param options.legacy - force the HTTP+SSE transport.
   */
  constructor({ url, headers = {}, timeoutMs = 30_000, legacy = false }) {
    this.url = url
    this.headers = headers
    this.timeoutMs = timeoutMs
    this.legacy = legacy
    this.onmessage = null
    this.onclose = null
  }

  /** Transport identity for diagnostics. */
  describe() {
    return {
      type: this.legacy ? 'sse' : 'streamable-http',
      url: this.url,
      sessionId: this.#sessionId ? '存在' : '无',
      protocolVersion: this.#protocolVersion ?? null,
    }
  }

  /** Whether a session id was negotiated. */
  get sessionId() {
    return this.#sessionId
  }

  /** Record the negotiated protocol version so later requests echo it. */
  setProtocolVersion(version) {
    this.#protocolVersion = version
  }

  /**
   * Establish the transport.
   * @returns transport identity for diagnostics.
   * @throws McpDiagnostic when the endpoint cannot be reached.
   */
  async start() {
    if (this.legacy) await this.#openLegacyStream()
    return this.describe()
  }

  /**
   * POST one JSON-RPC message (or write to the legacy message endpoint).
   * @param message - JSON-RPC message object.
   */
  async send(message) {
    if (this.#closed) throw new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.transport, 'HTTP 传输已关闭')
    const target = this.legacy ? await this.#legacyMessageUrl() : this.url
    const headers = {
      'content-type': 'application/json',
      accept: this.legacy ? 'application/json, text/event-stream' : ACCEPT_STREAMABLE,
      ...this.headers,
    }
    if (this.#sessionId) headers[MCP_SESSION_HEADER] = this.#sessionId
    if (this.#protocolVersion) headers[MCP_VERSION_HEADER] = this.#protocolVersion

    let response
    try {
      response = await fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      })
    } catch (error) {
      throw networkDiagnostic(error, target)
    }

    const sessionId = response.headers.get(MCP_SESSION_HEADER)
    if (sessionId && sessionId !== this.#sessionId) this.#sessionId = sessionId

    if (response.status === 202 || response.status === 204) {
      // Accepted with no body; the reply (if any) arrives on another stream.
      await response.body?.cancel().catch(() => {})
      return
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw statusDiagnostic(response.status, target, body)
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/event-stream')) {
      this.#pumpStream(response)
      return
    }
    const text = await response.text().catch(() => '')
    if (text.trim() === '') return
    for (const message of decodeBody(text, contentType)) this.onmessage?.(message)
  }

  /**
   * Tear down any open stream and mark the transport closed.
   * @returns settlement after the stream is cancelled.
   */
  async close() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#sseController?.abort()
    } catch {
      // already aborted
    }
    this.#sseController = null
  }

  /** Read a streaming POST body and dispatch each SSE event. */
  async #pumpStream(response) {
    const reader = response.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.#streamBuffer += decoder.decode(value, { stream: true })
        this.#streamBuffer = parseSseStream(this.#streamBuffer, (event) => {
          if (event.data === '') return
          let message
          try {
            message = JSON.parse(event.data)
          } catch {
            this.onclose?.(new McpDiagnostic(CODES.INVALID_FRAME, PHASES.transport, 'SSE 数据不是合法 JSON', {
              sample: redactText(event.data.slice(0, 300)),
            }))
            return
          }
          this.onmessage?.(message)
        })
      }
    } catch (error) {
      if (!this.#closed) {
        this.onclose?.(new McpDiagnostic(CODES.SSE_INTERRUPTED, PHASES.session, `SSE 流中断：${error?.message ?? error}`, {}))
      }
    }
  }

  /** Open the long-lived GET stream and wait for the `endpoint` event. */
  async #openLegacyStream() {
    this.#sseController = new AbortController()
    const headers = { accept: 'text/event-stream', ...this.headers }
    const waitForEndpoint = new Promise((resolve, reject) => {
      this.#sseReady = { resolve, reject }
    })
    const timer = setTimeout(() => {
      this.#sseReady?.reject(new McpDiagnostic(CODES.SESSION_MISSING, PHASES.session, '旧版 SSE 连接没有下发 endpoint 事件', { url: this.url }))
      this.#sseReady = null
    }, this.timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    let response
    try {
      response = await fetch(this.url, {
        method: 'GET',
        headers,
        signal: this.#sseController.signal,
        redirect: 'follow',
      })
    } catch (error) {
      clearTimeout(timer)
      throw networkDiagnostic(error, this.url)
    }
    if (!response.ok) {
      clearTimeout(timer)
      throw statusDiagnostic(response.status, this.url, await response.text().catch(() => ''))
    }
    const sessionId = response.headers.get(MCP_SESSION_HEADER)
    if (sessionId) this.#sessionId = sessionId
    const reader = response.body?.getReader()
    if (!reader) {
      clearTimeout(timer)
      throw new McpDiagnostic(CODES.SSE_INTERRUPTED, PHASES.session, 'SSE 响应没有可读流', { url: this.url })
    }
    let buffer = ''
    const decoder = new TextDecoder()
    ;(async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          buffer = parseSseStream(buffer, (event) => {
            if (event.event === 'endpoint') {
              const endpoint = event.data.trim()
              this.#messageUrl = new URL(endpoint, this.url).toString()
              clearTimeout(timer)
              this.#sseReady?.resolve(this.#messageUrl)
              this.#sseReady = null
              return
            }
            if (event.data === '') return
            try {
              this.onmessage?.(JSON.parse(event.data))
            } catch {
              this.onclose?.(new McpDiagnostic(CODES.INVALID_FRAME, PHASES.transport, 'SSE 数据不是合法 JSON', {}))
            }
          })
        }
        if (!this.#closed) {
          this.onclose?.(new McpDiagnostic(CODES.SSE_INTERRUPTED, PHASES.session, 'SSE 流已结束', { url: this.url }))
        }
      } catch (error) {
        if (!this.#closed) {
          this.onclose?.(new McpDiagnostic(CODES.SSE_INTERRUPTED, PHASES.session, `SSE 流中断：${error?.message ?? error}`, {}))
        }
      }
    })()
    await waitForEndpoint
  }

  /** The message URL of a legacy SSE session. */
  async #legacyMessageUrl() {
    if (this.#messageUrl) return this.#messageUrl
    if (this.#sseReady) {
      await new Promise((resolve, reject) => {
        const original = this.#sseReady
        this.#sseReady = {
          resolve: (value) => {
            original?.resolve(value)
            resolve(value)
          },
          reject: (error) => {
            original?.reject(error)
            reject(error)
          },
        }
      })
      if (this.#messageUrl) return this.#messageUrl
    }
    throw new McpDiagnostic(CODES.SESSION_MISSING, PHASES.session, '旧版 SSE 会话尚未就绪', { url: this.url })
  }
}

/** Decode an HTTP body that may be a single message or a batch. */
function decodeBody(text, contentType) {
  const trimmed = text.trim()
  if (trimmed === '') return []
  // Some servers answer an SSE request with `event:` frames but the wrong header.
  if (contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const messages = []
    parseSseStream(`${trimmed}\n\n`, (event) => {
      if (event.data === '') return
      try {
        messages.push(JSON.parse(event.data))
      } catch {
        // ignore malformed frame; the peer times out with a clearer diagnostic
      }
    })
    return messages
  }
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    throw new McpDiagnostic(CODES.INVALID_FRAME, PHASES.transport, 'HTTP 响应不是合法 JSON-RPC', {
      sample: redactText(trimmed.slice(0, 300)),
    })
  }
}
