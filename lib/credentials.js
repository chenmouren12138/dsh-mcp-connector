/**
 * Credential references: keep secrets out of `registry.json`.
 *
 * A connection parameter (an HTTP header value or a stdio `env` value) may be
 * written as `${credential:REF}`. The literal placeholder is what gets persisted,
 * rendered and redacted; the value is resolved from DSH's credentials service at
 * connect time (falling back to an environment variable of the same name), so
 * rotating a secret never edits a configuration file.
 *
 * Resolution happens per connection attempt, never at import time: a rotated
 * credential applies on the next reconnect or "test connection" without a
 * restart, and a missing one produces a structured `CREDENTIAL_MISSING`
 * diagnostic instead of a confusing 401.
 */
import { CODES, McpDiagnostic, PHASES } from './diagnostics.js'

/** `${credential:NAME}` with a deliberately narrow name grammar. */
const PLACEHOLDER = /\$\{credential:([A-Za-z0-9_.:-]{1,64})\}/g

/** Whether a string contains at least one credential placeholder. */
/**
 * Every credential reference used by one connection config.
 * @param config - normalized server config.
 * @returns unique refs, in first-use order.
 */
export function collectCredentialRefs(config) {
  const refs = new Set()
  const scan = (map) => {
    for (const value of Object.values(map ?? {})) {
      if (typeof value !== 'string') continue
      PLACEHOLDER.lastIndex = 0
      let match = PLACEHOLDER.exec(value)
      while (match !== null) {
        refs.add(match[1])
        match = PLACEHOLDER.exec(value)
      }
    }
  }
  scan(config?.headers)
  scan(config?.env)
  return [...refs]
}

/** Replace every placeholder in one string using `lookup(ref)`. */
function substitute(value, lookup) {
  PLACEHOLDER.lastIndex = 0
  return value.replace(PLACEHOLDER, (whole, ref) => {
    const resolved = lookup(ref)
    return resolved === undefined ? whole : resolved
  })
}

/**
 * Resolve a whole connection config.
 *
 * @param config - normalized server config (placeholders intact).
 * @param options.resolve - `async (ref) => string | undefined`; the caller owns the
 *   provider chain (credentials service, then environment).
 * @returns a copy with placeholders replaced.
 * @throws McpDiagnostic CREDENTIAL_MISSING listing every unresolved reference.
 */
export async function resolveCredentials(config, { resolve }) {
  const refs = collectCredentialRefs(config)
  if (refs.length === 0) return config
  const values = new Map()
  const missing = []
  for (const ref of refs) {
    let value
    try {
      value = await resolve(ref)
    } catch {
      value = undefined
    }
    if (typeof value === 'string' && value !== '') values.set(ref, value)
    else missing.push(ref)
  }
  if (missing.length > 0) {
    throw new McpDiagnostic(
      CODES.CREDENTIAL_MISSING,
      PHASES.config,
      `凭据未配置：${missing.join('、')}（在设置页保存该凭据，或设置同名环境变量）`,
      { refs: missing },
    )
  }
  const lookup = (ref) => values.get(ref)
  const rewrite = (map) => {
    if (map === undefined) return map
    const output = {}
    for (const [key, value] of Object.entries(map)) {
      output[key] = typeof value === 'string' ? substitute(value, lookup) : value
    }
    return output
  }
  return {
    ...config,
    ...(config.headers === undefined ? {} : { headers: rewrite(config.headers) }),
    ...(config.env === undefined ? {} : { env: rewrite(config.env) }),
  }
}

/**
 * Report whether each reference can be resolved, with its source, without ever
 * returning a value.
 *
 * @param config - normalized server config.
 * @param options.describe - `async (ref) => { configured, source? }` from the
 *   credentials service; `undefined` when the service is absent.
 * @param options.env - environment lookup, used as the documented fallback.
 */
export async function describeCredentials(config, { describe, env = process.env }) {
  const refs = collectCredentialRefs(config)
  const output = []
  for (const ref of refs) {
    let info
    if (typeof describe === 'function') {
      try {
        info = await describe(ref)
      } catch {
        info = undefined
      }
    }
    const fromEnv = typeof env?.[ref] === 'string' && env[ref] !== ''
    output.push({
      ref,
      configured: Boolean(info?.configured) || fromEnv,
      source: info?.configured ? (info.source ?? 'credentials') : fromEnv ? 'environment' : 'missing',
      writable: info?.writable ?? true,
    })
  }
  return output
}
