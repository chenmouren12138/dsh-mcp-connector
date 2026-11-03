/**
 * Host half of @local/dsh-mcp-connector.
 *
 * This is the MCP Client capability Seam inside the Cordis runtime: it speaks
 * JSON-RPC 2.0 to external MCP servers over stdio or Streamable HTTP (with the
 * legacy HTTP+SSE fallback), negotiates the protocol revision, maps each server's
 * tools onto `ctx.tools` as `mcp__<serverName>__<toolName>`, and exposes the
 * runtime registry the Settings page manages.
 *
 * Config split (the reason editing a server never remounts this plugin):
 * - deployment policy lives in this row's Cordis `config` (validated below);
 * - per-server connection parameters live in the plugin-owned runtime registry
 *   (`<dataDir>/registry.json`), which CRUD writes directly.
 *
 * Everything here is effect-scoped: the registry runtime is created inside one
 * `ctx.effect`, and its disposer closes every connection, clears every timer and
 * unregisters every tool generation in reverse order.
 */
import os from 'node:os'
import path from 'node:path'
import { Config, resolveConfig } from './lib/config.js'
import { McpRuntime } from './lib/runtime.js'
import { registerApi } from './lib/api.js'

export const name = 'dsh-mcp-connector'
export const inject = ['tools']
export { Config }
export { STATES, STATE_LABELS } from './lib/runtime.js'
export { CODES, PHASES } from './lib/diagnostics.js'
export { publicToolName } from './lib/toolbridge.js'
export { normalizeImport, exportEntries } from './lib/normalize.js'

/** Resolve the registry directory: explicit config wins, else `<DSH_HOME>/mcp-connector`. */
function resolveDataDir(config) {
  if (config.registry.dataDir) return path.resolve(config.registry.dataDir)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'mcp-connector')
}

/**
 * Mount the connector.
 *
 * @param ctx - the Host plugin context (must provide `tools`).
 * @param rawConfig - the row config; already validated by {@link Config}, but
 *   re-resolved here because programmatic mounting can bypass that step.
 * @returns the runtime, so tests and sibling plugins can read snapshots.
 */
export function apply(ctx, rawConfig) {
  const { value: config, issues } = resolveConfig(rawConfig)
  for (const problem of issues) {
    console.warn(`[mcp-connector] config ${problem.path?.join('.') ?? ''}: ${problem.message}`)
  }

  const dataDir = resolveDataDir(config)
  const runtime = new McpRuntime({
    ctx,
    config,
    dataDir,
    logger: {
      info: (line) => console.log(line),
      warn: (line) => console.warn(line),
      error: (line) => console.error(line),
    },
  })

  ctx.effect(() => {
    runtime.ready = runtime.init()
    runtime.ready.catch((error) => {
      console.error(`[mcp-connector] 注册表初始化失败：${error?.message ?? error}`)
    })
    return () => runtime.dispose()
  }, 'mcp-connector: runtime registry')

  // The web server is a sibling service, not a dependency: it may activate after
  // this row, so registering only when it happens to exist at apply time silently
  // loses the management API. `ctx.inject` runs the attachment when the service
  // appears (and disposes it if the provider goes away), which covers both orders.
  const attachApi = (inner) => {
    const webServer = inner.get('webServer') ?? inner.webServer
    if (!webServer) return
    registerApi(inner, { runtime, webServer })
    console.log('[mcp-connector] 管理 API 已挂载：/dsh-mcp-connector/{api,health,config}')
  }

  if (ctx.get('webServer')) {
    attachApi(ctx)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], attachApi)
  } else {
    console.warn('[mcp-connector] 本运行时不提供 webServer，设置页无法管理服务器')
  }

  console.log(
    `[mcp-connector] 已加载：数据目录 ${dataDir}，传输白名单 ${config.allowedTransports.join('/')}，`
    + `工具映射 ${config.exposeTools ? '开启' : '关闭'}`,
  )
  return runtime
}
