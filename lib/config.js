/**
 * Deployment-time configuration for @local/dsh-mcp-connector.
 *
 * Two layers, per the plugin's split-config contract:
 *
 * - This module validates the **deployment** layer (Cordis `Config`): global
 *   policy such as timeouts, allowed transports, reconnect behaviour and where
 *   the runtime registry persists. Changing it is a config change and therefore
 *   an HMR remount — that is expected and accepted.
 * - Per-server connection parameters are **runtime state** owned by
 *   `lib/registry.js`; they never appear here, so CRUD never remounts the
 *   plugin.
 *
 * The schema is expressed as a Standard Schema v1 object so Cordis can resolve a
 * row's config with `Config['~standard'].validate(...)`, plus a plain JSON Schema
 * mirror (`Config.schema`) that the settings form and static catalog tooling can
 * read without executing anything.
 */

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Transport ids this plugin implements. */
export const TRANSPORTS = Object.freeze(['stdio', 'streamable-http', 'sse'])

export const DEFAULTS = Object.freeze({
  enabled: true,
  defaultTimeoutMs: 30_000,
  probeTimeoutMs: 10_000,
  toolCallTimeoutMs: 60_000,
  allowedTransports: Object.freeze(['stdio', 'streamable-http']),
  registry: Object.freeze({ enabled: true, persist: true, dataDir: '' }),
  reconnect: Object.freeze({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 }),
  probeIntervalMs: 0,
  exposeTools: true,
  maxStderrLines: 40,
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(message, path) {
  return { message, path }
}

function readNumber(input, key, path, issues, { min, max, integer = false, fallback }) {
  const given = input[key]
  if (given === undefined) return fallback
  if (typeof given !== 'number' || !Number.isFinite(given)) {
    issues.push(issue(`需要数字，收到 ${typeof given}`, [...path, key]))
    return fallback
  }
  if (given < min || given > max) {
    issues.push(issue(`需要 ${min}..${max}，收到 ${given}`, [...path, key]))
  }
  return integer ? Math.round(given) : given
}

function readBoolean(input, key, path, issues, fallback) {
  const given = input[key]
  if (given === undefined) return fallback
  if (typeof given !== 'boolean') {
    issues.push(issue(`需要布尔值，收到 ${typeof given}`, [...path, key]))
    return fallback
  }
  return given
}

function readString(input, key, path, issues, fallback) {
  const given = input[key]
  if (given === undefined) return fallback
  if (typeof given !== 'string') {
    issues.push(issue(`需要字符串，收到 ${typeof given}`, [...path, key]))
    return fallback
  }
  return given
}

function readTransportList(input, path, issues) {
  const given = input.allowedTransports
  if (given === undefined) return [...DEFAULTS.allowedTransports]
  if (!Array.isArray(given) || given.length === 0) {
    issues.push(issue('需要至少一种传输类型', [...path, 'allowedTransports']))
    return [...DEFAULTS.allowedTransports]
  }
  const kept = []
  for (const [index, value] of given.entries()) {
    if (typeof value !== 'string' || !TRANSPORTS.includes(value)) {
      issues.push(issue(`未知传输类型 ${JSON.stringify(value)}`, [...path, 'allowedTransports', index]))
      continue
    }
    if (!kept.includes(value)) kept.push(value)
  }
  return kept.length > 0 ? kept : [...DEFAULTS.allowedTransports]
}

function readRegistry(input, path, issues) {
  const raw = input.registry
  const base = { ...DEFAULTS.registry }
  if (raw === undefined) return base
  if (!isPlainObject(raw)) {
    issues.push(issue('需要一个对象', [...path, 'registry']))
    return base
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(base, key)) issues.push(issue(`未知选项 "${key}"`, [...path, 'registry', key]))
  }
  return {
    enabled: readBoolean(raw, 'enabled', [...path, 'registry'], issues, base.enabled),
    persist: readBoolean(raw, 'persist', [...path, 'registry'], issues, base.persist),
    dataDir: readString(raw, 'dataDir', [...path, 'registry'], issues, base.dataDir),
  }
}

function readReconnect(input, path, issues) {
  const raw = input.reconnect
  const base = { ...DEFAULTS.reconnect }
  if (raw === undefined) return base
  if (!isPlainObject(raw)) {
    issues.push(issue('需要一个对象', [...path, 'reconnect']))
    return base
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(base, key)) issues.push(issue(`未知选项 "${key}"`, [...path, 'reconnect', key]))
  }
  const initialDelayMs = readNumber(raw, 'initialDelayMs', [...path, 'reconnect'], issues, {
    min: 1, max: MAX_TIMER_DELAY_MS, fallback: base.initialDelayMs,
  })
  const maxDelayMs = readNumber(raw, 'maxDelayMs', [...path, 'reconnect'], issues, {
    min: 1, max: MAX_TIMER_DELAY_MS, fallback: base.maxDelayMs,
  })
  const maxAttempts = readNumber(raw, 'maxAttempts', [...path, 'reconnect'], issues, {
    min: 1, max: 1000, integer: true, fallback: base.maxAttempts,
  })
  if (initialDelayMs > maxDelayMs) {
    issues.push(issue('initialDelayMs 不能大于 maxDelayMs', [...path, 'reconnect', 'initialDelayMs']))
  }
  return {
    enabled: readBoolean(raw, 'enabled', [...path, 'reconnect'], issues, base.enabled),
    initialDelayMs,
    maxDelayMs,
    maxAttempts,
  }
}

/**
 * Resolve raw row config into the value the runtime uses.
 * @param raw - the row's config, as written in cordis.patch.yml.
 * @returns `{ value, issues }`; the value is always usable, issues are advisory.
 */
export function resolveConfig(raw) {
  const issues = []
  const path = []
  const input = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(input)) {
    return { value: structuredCloneLike(DEFAULTS), issues: [issue('需要一个对象', [])] }
  }
  const known = new Set(Object.keys(DEFAULTS))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push(issue(`未知选项 "${key}"`, [key]))
  }
  const value = {
    enabled: readBoolean(input, 'enabled', path, issues, DEFAULTS.enabled),
    defaultTimeoutMs: readNumber(input, 'defaultTimeoutMs', path, issues, {
      min: 100, max: MAX_TIMER_DELAY_MS, fallback: DEFAULTS.defaultTimeoutMs,
    }),
    probeTimeoutMs: readNumber(input, 'probeTimeoutMs', path, issues, {
      min: 100, max: MAX_TIMER_DELAY_MS, fallback: DEFAULTS.probeTimeoutMs,
    }),
    toolCallTimeoutMs: readNumber(input, 'toolCallTimeoutMs', path, issues, {
      min: 100, max: MAX_TIMER_DELAY_MS, fallback: DEFAULTS.toolCallTimeoutMs,
    }),
    allowedTransports: readTransportList(input, path, issues),
    registry: readRegistry(input, path, issues),
    reconnect: readReconnect(input, path, issues),
    probeIntervalMs: readNumber(input, 'probeIntervalMs', path, issues, {
      min: 0, max: MAX_TIMER_DELAY_MS, fallback: DEFAULTS.probeIntervalMs,
    }),
    exposeTools: readBoolean(input, 'exposeTools', path, issues, DEFAULTS.exposeTools),
    maxStderrLines: readNumber(input, 'maxStderrLines', path, issues, {
      min: 1, max: 400, integer: true, fallback: DEFAULTS.maxStderrLines,
    }),
  }
  return { value, issues }
}

/** Small structured clone that survives frozen defaults. */
function structuredCloneLike(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * The subset the Client half renders (no secrets exist in this layer, but the
 * shape keeps the contract explicit).
 * @param value - resolved config.
 */
export function publicConfig(value) {
  return {
    enabled: value.enabled,
    defaultTimeoutMs: value.defaultTimeoutMs,
    probeTimeoutMs: value.probeTimeoutMs,
    toolCallTimeoutMs: value.toolCallTimeoutMs,
    allowedTransports: [...value.allowedTransports],
    registry: { ...value.registry },
    reconnect: { ...value.reconnect },
    probeIntervalMs: value.probeIntervalMs,
    exposeTools: value.exposeTools,
    maxStderrLines: value.maxStderrLines,
  }
}

/**
 * Cordis `Config`: Standard Schema v1 plus a JSON Schema mirror.
 *
 * The JSON Schema mirror exists because the cordis loader only needs
 * `~standard.validate`, while any tooling that wants to *describe* the row
 * (settings forms, catalog generation) reads `.schema` without executing code.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-mcp-connector',
    validate(raw) {
      const { value, issues } = resolveConfig(raw)
      return issues.length > 0 ? { issues } : { value }
    },
  },
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: { type: 'boolean', default: true, description: '总开关：关闭后不连接任何服务器，也不注册任何工具。' },
      defaultTimeoutMs: { type: 'number', minimum: 100, default: 30000, description: '握手与工具发现的默认超时（毫秒）。' },
      probeTimeoutMs: { type: 'number', minimum: 100, default: 10000, description: '「测试连接」独立超时（毫秒）。' },
      toolCallTimeoutMs: { type: 'number', minimum: 100, default: 60000, description: '单次 tools/call 超时（毫秒）。' },
      allowedTransports: {
        type: 'array',
        items: { type: 'string', enum: ['stdio', 'streamable-http', 'sse'] },
        default: ['stdio', 'streamable-http'],
        description: '允许的传输类型白名单。',
      },
      registry: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', default: true, description: '是否启用运行时服务器注册表。' },
          persist: { type: 'boolean', default: true, description: '注册表是否写入磁盘。' },
          dataDir: { type: 'string', default: '', description: '注册表目录，留空为 <DSH_HOME>/mcp-connector。' },
        },
      },
      reconnect: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', default: true },
          initialDelayMs: { type: 'number', minimum: 1, default: 500 },
          maxDelayMs: { type: 'number', minimum: 1, default: 30000 },
          maxAttempts: { type: 'number', minimum: 1, default: 10 },
        },
      },
      probeIntervalMs: { type: 'number', minimum: 0, default: 0, description: '可选的周期探测间隔；0 表示不做心跳。' },
      exposeTools: { type: 'boolean', default: true, description: '是否把发现的工具注册到工具运行时。' },
      maxStderrLines: { type: 'number', minimum: 1, default: 40, description: '诊断中保留的 stderr 尾部行数。' },
    },
  },
}
