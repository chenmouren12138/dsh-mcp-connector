/**
 * Structured failure vocabulary and redaction for MCP diagnostics.
 *
 * Every failure crossing the plugin boundary is an {@link McpDiagnostic}:
 * `{ code, phase, message, detail }`. The `phase` says *where* the chain broke —
 * config validation, transport establishment, protocol handshake, capability
 * negotiation or tool discovery — so the settings page can point at the failing
 * stage instead of printing one opaque string.
 *
 * Anything that may reach the browser passes {@link redact} first: `env`,
 * `headers` and stderr lines routinely carry bearer tokens and API keys.
 */

/** Failure stages, in the order they can occur during an attempt. */
export const PHASES = Object.freeze({
  config: 'config',
  auth: 'auth',
  transport: 'transport',
  handshake: 'handshake',
  capabilities: 'capabilities',
  tools: 'tools',
  session: 'session',
  call: 'call',
})

/** Stable diagnostic codes, grouped by domain. */
export const CODES = Object.freeze({
  // configuration
  CONFIG_INVALID: 'CONFIG_INVALID',
  SERVER_NOT_FOUND: 'SERVER_NOT_FOUND',
  // authorization
  OAUTH_REQUIRED: 'OAUTH_REQUIRED',
  OAUTH_FAILED: 'OAUTH_FAILED',
  OAUTH_UNSUPPORTED: 'OAUTH_UNSUPPORTED',
  SERVER_NAME_INVALID: 'SERVER_NAME_INVALID',
  SERVER_NAME_CONFLICT: 'SERVER_NAME_CONFLICT',
  COMMAND_MISSING: 'COMMAND_MISSING',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  COMMAND_NOT_EXECUTABLE: 'COMMAND_NOT_EXECUTABLE',
  CWD_MISSING: 'CWD_MISSING',
  URL_INVALID: 'URL_INVALID',
  TRANSPORT_NOT_ALLOWED: 'TRANSPORT_NOT_ALLOWED',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  CREDENTIAL_UNAVAILABLE: 'CREDENTIAL_UNAVAILABLE',
  DUPLICATE_TOOL: 'DUPLICATE_TOOL',
  // transport
  SPAWN_FAILED: 'SPAWN_FAILED',
  PROCESS_EXITED: 'PROCESS_EXITED',
  INVALID_FRAME: 'INVALID_FRAME',
  TRANSPORT_CLOSED: 'TRANSPORT_CLOSED',
  NETWORK_DNS: 'NETWORK_DNS',
  NETWORK_TCP: 'NETWORK_TCP',
  NETWORK_TLS: 'NETWORK_TLS',
  HTTP_AUTH: 'HTTP_AUTH',
  HTTP_NOT_FOUND: 'HTTP_NOT_FOUND',
  HTTP_SERVER_ERROR: 'HTTP_SERVER_ERROR',
  HTTP_UNEXPECTED: 'HTTP_UNEXPECTED',
  // protocol
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  PROTOCOL_INCOMPATIBLE: 'PROTOCOL_INCOMPATIBLE',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  // session
  SESSION_MISSING: 'SESSION_MISSING',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SSE_INTERRUPTED: 'SSE_INTERRUPTED',
  // tool execution
  TOOL_ERROR: 'TOOL_ERROR',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  // lifecycle
  DISABLED: 'DISABLED',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  UNKNOWN: 'UNKNOWN',
})

/**
 * One structured, redacted failure.
 *
 * `detail` is a plain object (exit code, stderr tail, HTTP status, JSON-RPC error
 * body, ...) — never a formatted string, so the UI can render fields.
 */
export class McpDiagnostic extends Error {
  /**
   * @param code - stable code from {@link CODES}.
   * @param phase - stage from {@link PHASES}.
   * @param message - short, already-safe human sentence.
   * @param detail - structured extra facts; redacted on construction.
   */
  constructor(code, phase, message, detail = {}) {
    super(message)
    this.name = 'McpDiagnostic'
    this.code = code
    this.phase = phase
    this.detail = redact(detail)
  }

  /** The wire shape the settings page consumes. */
  toJSON() {
    return { code: this.code, phase: this.phase, message: this.message, detail: this.detail }
  }
}

/** Coerce any thrown value into an {@link McpDiagnostic}. */
export function asDiagnostic(error, fallbackCode = CODES.UNKNOWN, fallbackPhase = PHASES.transport) {
  if (error instanceof McpDiagnostic) return error
  const message = error instanceof Error ? error.message : String(error)
  return new McpDiagnostic(error?.code ?? fallbackCode, error?.phase ?? fallbackPhase, message, {
    name: error?.name,
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
    cause: describeCause(error),
  })
}

/** Flatten a Node/undici error cause chain into codes the UI can switch on. */
function describeCause(error) {
  const chain = []
  let current = error?.cause
  let guard = 0
  while (current && guard < 4) {
    chain.push({ code: current.code, message: current.message, name: current.name })
    current = current.cause
    guard += 1
  }
  return chain.length > 0 ? chain : undefined
}

const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|passw|credential|cookie|bearer|session[-_]?id)/i

/** Keys whose *values* are replaced wholesale, at any depth. */
const SECRET_VALUE_KEYS = new Set(['Authorization', 'authorization', 'x-api-key', 'X-Api-Key', 'apiKey', 'api-key'])

/**
 * Replace credential-shaped values in a diagnostic payload.
 *
 * Rules:
 * - a key matching {@link SENSITIVE_KEY} keeps its name but its value becomes
 *   `••••` (or `••••redacted (n chars)` for long secrets);
 * - free text (stderr tails, error messages) has `Bearer ...`, `token=...`,
 *   `sk-...`, `ghp_...` and long base64-ish runs masked in place;
 * - URIs have their `user:pass@` userinfo and query tokens removed.
 *
 * @param value - any JSON-ish value.
 * @param seen - cycle guard.
 * @returns a structurally similar, secret-free value.
 */
export function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (SECRET_VALUE_KEYS.has(key) || SENSITIVE_KEY.test(key)) {
      output[key] = maskValue(item)
      continue
    }
    output[key] = redact(item, seen)
  }
  return output
}

function maskValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') return '••••'
  const text = String(value)
  if (text.length === 0) return ''
  return text.length <= 8 ? '••••' : `••••（已脱敏，${text.length} 字符）`
}

const TEXT_RULES = [
  // Authorization headers embedded in free text.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ••••'],
  // key=value / key: value pairs whose key looks like a credential.
  [/\b([A-Za-z0-9_.-]*(?:token|secret|api[-_]?key|password|credential)[A-Za-z0-9_.-]*)\s*[=:]\s*("?)([^\s"',;]{6,})\2/gi, '$1=••••'],
  // Well-known token shapes.
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-••••'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh•_••••'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox•-••••'],
  // URL userinfo and query credentials.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1••••@'],
  [/([?&](?:token|key|api[-_]?key|sig|signature|password)=)[^&\s]+/gi, '$1••••'],
  // Long opaque runs that appear in stderr dumps.
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '••••'],
]

/**
 * Mask credential-shaped substrings inside a free-text field.
 * @param text - stderr line, error message, header value.
 */
export function redactText(text) {
  let output = String(text)
  for (const [pattern, replacement] of TEXT_RULES) output = output.replace(pattern, replacement)
  return output
}

/**
 * Redact an environment map for display: keys stay, values are masked.
 * @param env - the user-declared `env` of a stdio server.
 */
/**
 * Redact a header map for display: names stay, values are masked.
 * @param headers - the user-declared `headers` of an HTTP server.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
