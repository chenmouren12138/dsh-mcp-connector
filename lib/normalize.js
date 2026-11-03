/**
 * Server-entry normalization, validation and JSON interchange.
 *
 * Three callers share this module so the rules cannot drift:
 * - the settings page posting a draft (add / edit / probe);
 * - the JSON importer (Claude Desktop, VS Code, bare map, single object, array);
 * - the persistence layer reading the registry back after a restart.
 *
 * Contract: *lenient reading, strict normalization*. Whatever shape came in, what
 * leaves is one canonical {@link McpServerEntry} array, and every rejected row
 * carries its own reason — the importer never silently drops or half-writes.
 */
import { CODES, McpDiagnostic, PHASES, redactText } from './diagnostics.js'

/** `serverName` doubles as the tool namespace, so it is deliberately narrow. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Canonical transports. `sse` is the legacy HTTP+SSE fallback. */
/** Transport spellings seen in the wild, mapped onto the canonical ones. */
const TRANSPORT_ALIASES = new Map([
  ['stdio', 'stdio'],
  ['local', 'stdio'],
  ['process', 'stdio'],
  ['streamable-http', 'streamable-http'],
  ['streamablehttp', 'streamable-http'],
  ['streamable_http', 'streamable-http'],
  ['http', 'streamable-http'],
  ['https', 'streamable-http'],
  ['remote', 'streamable-http'],
  ['sse', 'sse'],
  ['http+sse', 'sse'],
  ['http-sse', 'sse'],
])

/** Keys that identify a server in the various JSON dialects. */
const NAME_KEYS = ['serverName', 'server_name', 'name', 'id', 'label']
/** Keys that identify the connection body. */
const COMMAND_KEYS = ['command', 'cmd', 'executable']
const URL_KEYS = ['url', 'endpoint', 'serverUrl', 'server_url', 'baseUrl']
const ARGS_KEYS = ['args', 'arguments', 'argv']
const HEADERS_KEYS = ['headers', 'header', 'httpHeaders']
const ENV_KEYS = ['env', 'environment', 'envVars']
const TYPE_KEYS = ['type', 'transport', 'kind', 'protocol']

/** Fields this plugin understands on one entry; anything else is reported. */
const KNOWN_ENTRY_KEYS = new Set([
  'id', 'serverName', 'name', 'server_name', 'label',
  'command', 'cmd', 'executable', 'args', 'arguments', 'argv', 'env', 'environment', 'envVars', 'cwd',
  'url', 'endpoint', 'serverUrl', 'server_url', 'baseUrl', 'headers', 'header', 'httpHeaders',
  'type', 'transport', 'kind', 'protocol',
  'disabled', 'enabled',
  'toolCallTimeoutMs', 'timeoutMs', 'toolTimeoutMs',
  'category', 'logLevel', 'version',
])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First string value among `keys`, or `undefined`. */
function pickString(entry, keys) {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** First present value among `keys`, or `undefined`. */
function pickAny(entry, keys) {
  for (const key of keys) if (entry[key] !== undefined) return entry[key]
  return undefined
}

/** Turn any label into a portable tool-name prefix. */
export function slugServerName(label) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? 'mcp' : slug
}

/** Category is a free-form tag; trim it and cap the length. */
function normalizeCategory(value) {
  if (typeof value !== 'string') return {}
  const text = value.trim().slice(0, 24)
  return text === '' || text === 'auto' ? {} : { category: text }
}

/** Normalize a transport spelling; `undefined` means "infer from the body". */
export function normalizeTransport(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return TRANSPORT_ALIASES.get(value.trim().toLowerCase())
}

/** Normalize a string map (env / headers); non-string values are coerced. */
function normalizeStringMap(value, field, issues, path) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    issues.push({ path: [...path, field], message: '需要对象（键值对）', code: CODES.CONFIG_INVALID })
    return {}
  }
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    if (typeof item === 'object') {
      issues.push({ path: [...path, field, key], message: '值需要是字符串', code: CODES.CONFIG_INVALID })
      continue
    }
    output[key] = String(item)
  }
  return output
}

/** Normalize argv: array of strings, or a single shell-ish string split on spaces. */
function normalizeArgs(value, issues, path) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    const args = []
    for (const [index, item] of value.entries()) {
      if (typeof item === 'string' || typeof item === 'number') args.push(String(item))
      else issues.push({ path: [...path, 'args', index], message: '参数需要是字符串', code: CODES.CONFIG_INVALID })
    }
    return args
  }
  if (typeof value === 'string') return splitArgs(value)
  issues.push({ path: [...path, 'args'], message: 'args 需要是数组或字符串', code: CODES.CONFIG_INVALID })
  return []
}

/** Split a command line into argv, honouring single/double quotes. */
export function splitArgs(input) {
  const text = String(input)
  const args = []
  let current = ''
  let quote = ''
  let escaped = false
  for (const char of text) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') args.push(current)
  return args
}

/**
 * Normalize one server entry coming from any dialect into the canonical shape.
 *
 * @param raw - the entry (object) with any of the accepted spellings.
 * @param options.fallbackName - name to use when the entry carries none (map key).
 * @param options.index - position, used in issue paths.
 * @returns `{ entry, issues }`; `entry` is `undefined` when the row is unusable.
 */
export function normalizeEntry(raw, { fallbackName, index = 0 } = {}) {
  const issues = []
  const path = ['servers', index]
  if (!isPlainObject(raw)) {
    issues.push({ path, message: '服务器条目必须是对象', code: CODES.CONFIG_INVALID })
    return { entry: undefined, issues }
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) issues.push({ path: [...path, key], message: `不认识的字段 "${key}"`, code: CODES.CONFIG_INVALID, level: 'warning' })
  }

  const serverName = pickString(raw, NAME_KEYS) ?? fallbackName
  if (typeof serverName !== 'string' || serverName.trim() === '') {
    issues.push({
      path: [...path, 'serverName'],
      message: 'serverName 不能为空',
      code: CODES.SERVER_NAME_INVALID,
    })
    return { entry: undefined, issues }
  }
  // The name is what people see; the tool prefix has to stay portable, so a
  // friendly name is slugged and kept as displayName.
  const friendly = serverName.trim().slice(0, 40)
  const resolvedName = SERVER_NAME_PATTERN.test(friendly) ? friendly : slugServerName(friendly)
  const displayName = SERVER_NAME_PATTERN.test(friendly) ? undefined : friendly

  const declaredTransport = normalizeTransport(pickAny(raw, TYPE_KEYS))
  const command = pickString(raw, COMMAND_KEYS)
  const url = pickString(raw, URL_KEYS)
  const transport = declaredTransport ?? (command !== undefined ? 'stdio' : url !== undefined ? 'streamable-http' : undefined)

  if (transport === undefined) {
    issues.push({
      path: [...path, 'transport'],
      message: '无法判断传输方式：需要 command（stdio）或 url（HTTP）',
      code: CODES.CONFIG_INVALID,
    })
    return { entry: undefined, issues }
  }
  if (declaredTransport !== undefined && command !== undefined && declaredTransport !== 'stdio') {
    issues.push({
      path: [...path, 'type'],
      message: `声明为 ${declaredTransport} 却提供了 command，按声明处理`,
      code: CODES.CONFIG_INVALID,
      level: 'warning',
    })
  }
  if (declaredTransport !== undefined && url !== undefined && declaredTransport === 'stdio') {
    issues.push({
      path: [...path, 'type'],
      message: '声明为 stdio 却提供了 url，按声明处理',
      code: CODES.CONFIG_INVALID,
      level: 'warning',
    })
  }

  const disabled = raw.disabled === true || raw.enabled === false
  const toolCallTimeoutMs = pickAny(raw, ['toolCallTimeoutMs', 'toolTimeoutMs', 'timeoutMs'])

  if (transport === 'stdio') {
    if (command === undefined) {
      issues.push({ path: [...path, 'command'], message: 'stdio 服务器缺少 command', code: CODES.COMMAND_MISSING })
      return { entry: undefined, issues }
    }
    if (url !== undefined) {
      issues.push({ path: [...path, 'url'], message: 'stdio 服务器不接受 url，已忽略', code: CODES.CONFIG_INVALID, level: 'warning' })
    }
    const entry = {
      serverName: resolvedName,
      ...(displayName === undefined ? {} : { displayName }),
      disabled,
      config: {
        transport: 'stdio',
        command,
        args: normalizeArgs(pickAny(raw, ARGS_KEYS), issues, path),
        env: normalizeStringMap(pickAny(raw, ENV_KEYS), 'env', issues, path),
        cwd: typeof raw.cwd === 'string' ? raw.cwd.trim() : '',
        ...(typeof toolCallTimeoutMs === 'number' ? { toolCallTimeoutMs } : {}),
        ...normalizeCategory(raw.category),
      },
    }
    return { entry, issues }
  }

  if (url === undefined) {
    issues.push({ path: [...path, 'url'], message: `${transport} 服务器缺少 url`, code: CODES.URL_INVALID })
    return { entry: undefined, issues }
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    issues.push({ path: [...path, 'url'], message: `url 不是合法地址：${redactText(url)}`, code: CODES.URL_INVALID })
    return { entry: undefined, issues }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push({ path: [...path, 'url'], message: 'url 必须是 http(s) 地址', code: CODES.URL_INVALID })
    return { entry: undefined, issues }
  }
  if (command !== undefined) {
    issues.push({ path: [...path, 'command'], message: 'HTTP 服务器不接受 command，已忽略', code: CODES.CONFIG_INVALID, level: 'warning' })
  }
  const entry = {
    serverName: resolvedName,
    ...(displayName === undefined ? {} : { displayName }),
    disabled,
    config: {
      transport,
      url: parsed.toString(),
      headers: normalizeStringMap(pickAny(raw, HEADERS_KEYS), 'headers', issues, path),
      ...(typeof toolCallTimeoutMs === 'number' ? { toolCallTimeoutMs } : {}),
      ...normalizeCategory(raw.category),
    },
  }
  return { entry, issues }
}

/** Errors only, dropping advisory warnings. */
export function blockingIssues(issues) {
  return issues.filter((item) => item.level !== 'warning')
}

/**
 * Split an unknown JSON document into a list of `(name, entry)` pairs plus a
 * dialect label. Accepts every shape the requirement names, and nothing is
 * dropped: unknown shapes become a single failing row.
 *
 * @param input - parsed JSON document.
 * @returns `{ dialect, rows }` where `rows` is `[{ name?, raw, index }]`.
 */
export function dialectRows(input) {
  if (Array.isArray(input)) {
    return { dialect: 'array', rows: input.map((raw, index) => ({ raw, index })) }
  }
  if (!isPlainObject(input)) {
    return { dialect: 'invalid', rows: [{ raw: input, index: 0, reason: '顶层需要是对象或数组' }] }
  }
  for (const key of ['mcpServers', 'mcp_servers', 'servers', 'mcp']) {
    const value = input[key]
    if (isPlainObject(value)) {
      return {
        dialect: key === 'servers' ? 'vscode-map' : 'mcpServers-map',
        rows: Object.entries(value).map(([name, raw], index) => ({ name, raw, index })),
      }
    }
    if (Array.isArray(value)) {
      return { dialect: 'servers-array', rows: value.map((raw, index) => ({ raw, index })) }
    }
  }
  // A bare map: every value looks like a server entry.
  const values = Object.values(input)
  if (values.length > 0 && values.every((value) => isPlainObject(value))) {
    const looksLikeEntries = values.some((value) => pickString(value, [...COMMAND_KEYS, ...URL_KEYS]) !== undefined)
    if (looksLikeEntries) {
      return {
        dialect: 'bare-map',
        rows: Object.entries(input).map(([name, raw], index) => ({ name, raw, index })),
      }
    }
  }
  // A single entry object.
  if (pickString(input, [...COMMAND_KEYS, ...URL_KEYS]) !== undefined) {
    return { dialect: 'single', rows: [{ raw: input, index: 0 }] }
  }
  return { dialect: 'unknown', rows: [{ raw: input, index: 0, reason: '无法识别的 JSON 结构' }] }
}

/**
 * Validate a whole JSON document into canonical entries.
 *
 * Every row is validated independently and reported with its own reason; the
 * caller decides whether to write. Nothing is normalized "best effort" past a
 * blocking issue.
 *
 * @param input - parsed JSON document.
 * @returns `{ dialect, accepted, rejected }`.
 */
export function normalizeImport(input) {
  const { dialect, rows } = dialectRows(input)
  const accepted = []
  const rejected = []
  const seen = new Set()

  for (const row of rows) {
    if (row.reason) {
      rejected.push({ index: row.index, name: row.name, code: CODES.CONFIG_INVALID, message: row.reason, path: ['servers', row.index] })
      continue
    }
    const { entry, issues } = normalizeEntry(row.raw, { fallbackName: row.name, index: row.index })
    const blocking = blockingIssues(issues)
    if (blocking.length > 0 || entry === undefined) {
      rejected.push({
        index: row.index,
        name: row.name ?? entry?.serverName,
        code: blocking[0]?.code ?? CODES.CONFIG_INVALID,
        message: blocking.map((item) => item.message).join('；'),
        path: blocking[0]?.path ?? ['servers', row.index],
      })
      continue
    }
    if (seen.has(entry.serverName)) {
      rejected.push({
        index: row.index,
        name: entry.serverName,
        code: CODES.SERVER_NAME_CONFLICT,
        message: `serverName "${entry.serverName}" 在导入内容中重复`,
        path: ['servers', row.index, 'serverName'],
      })
      continue
    }
    seen.add(entry.serverName)
    accepted.push({ ...entry, warnings: issues.filter((item) => item.level === 'warning') })
  }
  return { dialect, accepted, rejected }
}

/**
 * Serialize entries into one of the three export shapes.
 *
 * @param entries - canonical entries (`{ serverName, config, disabled }`).
 * @param format - `mcpServers` (default), `map` or `array`.
 * @returns a JSON-serializable document.
 */
export function exportEntries(entries, format = 'mcpServers') {
  const body = {}
  for (const entry of entries) body[entry.serverName] = toWireEntry(entry)
  if (format === 'map') return body
  if (format === 'array') return entries.map((entry) => ({ serverName: entry.serverName, ...toWireEntry(entry) }))
  return { mcpServers: body }
}

/** One entry in the dialects the importer accepts (Claude Desktop / VS Code). */
export function toWireEntry(entry) {
  const config = entry.config
  const output = { type: config.transport }
  if (config.transport === 'stdio') {
    output.command = config.command
    if (config.args?.length > 0) output.args = [...config.args]
    if (config.env && Object.keys(config.env).length > 0) output.env = { ...config.env }
    if (config.cwd) output.cwd = config.cwd
  } else {
    output.url = config.url
    if (config.headers && Object.keys(config.headers).length > 0) output.headers = { ...config.headers }
  }
  if (config.toolCallTimeoutMs) output.toolCallTimeoutMs = config.toolCallTimeoutMs
  if (entry.disabled) output.disabled = true
  return output
}

/**
 * Normalize one entry posted by the settings form.
 *
 * The form posts the same field names the JSON dialect uses, so this is a thin
 * wrapper that also enforces transport policy and adds the display-only fields.
 *
 * @param payload - `{ serverName, config }` or a flat entry.
 * @param options.allowedTransports - deployment allow-list.
 * @returns `{ entry, issues }`.
 */
export function normalizeDraft(payload, { allowedTransports, index = 0 } = {}) {
  const flat = isPlainObject(payload?.config)
    ? { ...payload.config, serverName: payload.serverName, disabled: payload.disabled }
    : payload
  const { entry, issues } = normalizeEntry(flat, { index })
  if (entry === undefined) return { entry, issues }
  if (Array.isArray(allowedTransports) && !allowedTransports.includes(entry.config.transport)) {
    return {
      entry: undefined,
      issues: [
        ...issues,
        {
          path: ['servers', index, 'transport'],
          message: `传输 ${entry.config.transport} 未被部署允许（允许：${allowedTransports.join('、')}）`,
          code: CODES.TRANSPORT_NOT_ALLOWED,
        },
      ],
    }
  }
  return { entry, issues }
}

/**
 * A display-safe summary of one entry: header names and env keys, never values.
 * @param entry - canonical entry.
 */
export function describeEntry(entry) {
  const config = entry.config
  if (config.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: [...config.args],
      cwd: config.cwd || null,
      env: Object.keys(config.env).length > 0 ? Object.fromEntries(Object.keys(config.env).map((key) => [key, '已设置'])) : {},
    }
  }
  return {
    transport: config.transport,
    url: config.url,
    // Header values reach the settings page so the editor can populate and
    // reveal them on demand; the page masks them by default. Diagnostics and
    // error details stay redacted — this projection is the one deliberate place
    // a value is handed back to the same-origin UI that edits it.
    headers: { ...config.headers },
  }
}

/** Turn a validation issue into a diagnostic. */
export function issueToDiagnostic(issueList) {
  const first = blockingIssues(issueList)[0] ?? issueList[0]
  return new McpDiagnostic(
    first?.code ?? CODES.CONFIG_INVALID,
    PHASES.config,
    issueList.map((item) => item.message).join('；') || '配置不合法',
    { issues: issueList },
  )
}
