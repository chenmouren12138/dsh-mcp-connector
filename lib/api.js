/**
 * Same-origin management API.
 *
 * The Settings page is a browser half of this plugin, so the only channel between
 * the two halves is HTTP on the host's own server: no Remote schema, no extra
 * capability, no new auth surface. `GET` returns the full snapshot the page
 * renders; `POST` carries one action with one result receipt.
 *
 * Routes:
 * - `GET  <base>`      full registry snapshot
 * - `POST <base>`      `{ action, payload }`
 * - `GET  <health>`    health + counters (for the Web UI or ops tooling)
 * - `GET  <config>`    deployment policy, so the page can explain what is allowed
 */
import { McpDiagnostic, PHASES } from './diagnostics.js'

const MAX_BODY = 2 * 1024 * 1024

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new McpDiagnostic('BODY_TOO_LARGE', PHASES.config, '请求体超过 2MB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new McpDiagnostic('INVALID_JSON', PHASES.config, '请求体不是合法 JSON')
  }
}

function failure(res, error, status = 400) {
  const diagnostic = error instanceof McpDiagnostic
    ? error
    : new McpDiagnostic('ACTION_FAILED', PHASES.config, error?.message ?? String(error), {})
  sendJson(res, status, { ok: false, error: diagnostic.toJSON() })
}

/**
 * Register the management API on the host web server.
 *
 * @param ctx - Cordis context (owns the disposers).
 * @param options.runtime - the {@link McpRuntime} instance.
 * @param options.webServer - the host web server service.
 * @param options.base - route prefix.
 */
export function registerApi(ctx, { runtime, webServer, base = '/dsh-mcp-connector' }) {
  const actions = {
    state: () => runtime.snapshot(),
    addServer: (payload) => runtime.addServer(payload),
    updateServer: (payload) => runtime.updateServer(String(payload.id), payload),
    removeServer: (payload) => runtime.removeServer(String(payload.id)),
    setDisabled: (payload) => runtime.setDisabled(String(payload.id), Boolean(payload.disabled)),
    retryServer: (payload) => runtime.retryServer(String(payload.id)),
    refreshServer: (payload) => runtime.refreshServer(String(payload.id)),
    testConnection: (payload) => runtime.testConnection(payload),
    importJson: async (payload) => {
      const result = await runtime.importJson(payload)
      if (result.ok === false) {
        // Validation failures are a structured result, not a transport error: the
        // page lists every rejected row and nothing was written.
        throw Object.assign(new Error(result.message), { diagnostic: result })
      }
      return result
    },
    exportJson: (payload) => runtime.exportJson({ format: payload?.format ?? 'mcpServers' }),
    credentialStatus: (payload) => runtime.credentialStatus(payload?.id),
    setCredential: (payload) => runtime.putCredential(payload?.ref, payload?.value),
    unsetCredential: (payload) => runtime.unsetCredential(payload?.ref),
    health: () => runtime.health(),
  }

  const apiHandler = async (req, res) => {
    try {
      await runtime.ready?.catch(() => {})
      if (req.method === 'GET' || req.method === 'HEAD') {
        const snapshot = runtime.snapshot()
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end()
          return
        }
        // Credential status is async (the provider is asked per reference) and
        // carries no values, so it rides the snapshot instead of the sync state.
        snapshot.credentials = await runtime.credentialStatus()
        sendJson(res, 200, { ok: true, data: snapshot })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', phase: 'config', message: '只支持 GET/POST' } })
        return
      }
      const body = await readBody(req)
      const action = typeof body.action === 'string' ? body.action : ''
      const handler = actions[action]
      if (handler === undefined) {
        sendJson(res, 404, { ok: false, error: { code: 'UNKNOWN_ACTION', phase: 'config', message: `未知操作：${action}` } })
        return
      }
      let data
      try {
        data = await handler(body.payload ?? {})
      } catch (error) {
        if (action === 'importJson' && error?.diagnostic) {
          sendJson(res, 200, { ok: false, error: { code: error.diagnostic.code ?? 'IMPORT_REJECTED', phase: 'config', message: error.message, detail: error.diagnostic } })
          return
        }
        throw error
      }
      sendJson(res, 200, { ok: true, data })
    } catch (error) {
      failure(res, error)
    }
  }

  const healthHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
      res.end('method not allowed')
      return
    }
    sendJson(res, 200, { ok: true, data: runtime.health() })
  }

  const configHandler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
      res.end('method not allowed')
      return
    }
    sendJson(res, 200, { ok: true, data: runtime.snapshot().config })
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: `${base}/api`, handler: apiHandler }), 'mcp-connector: api')
  ctx.effect(() => webServer.register({ kind: 'exact', path: `${base}/health`, handler: healthHandler }), 'mcp-connector: health')
  ctx.effect(() => webServer.register({ kind: 'exact', path: `${base}/config`, handler: configHandler }), 'mcp-connector: config')

  return { api: `${base}/api`, health: `${base}/health`, config: `${base}/config` }
}
