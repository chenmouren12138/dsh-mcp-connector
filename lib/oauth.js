/**
 * MCP OAuth 2.1 client (authorization code + PKCE), the subset a desktop host
 * needs: discover the authorization server, register a public client, run the
 * loopback redirect, exchange and refresh tokens.
 *
 * Nothing here stores secrets — the runtime keeps tokens in the DSH credential
 * store and only hands this module the values it needs per exchange.
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'

const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
const AS_METADATA_PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']

export function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE S256 pair. The verifier never leaves this process. */
export function createPkce() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function createState() {
  return base64url(randomBytes(16))
}

async function getJson(url, init) {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'follow',
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await response.text()
    let body = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, status: 0, error }
  }
}

/**
 * Protected resource metadata (RFC 9728). Tries the path-suffixed form first,
 * which is what the specification asks for, then the origin form many servers
 * actually ship.
 */
export function protectedResourceCandidates(resourceUrl) {
  const url = new URL(resourceUrl)
  const path = url.pathname.replace(/\/+$/, '')
  const list = [`${url.origin}${PROTECTED_RESOURCE_PATH}${path}`]
  if (path !== '') list.push(`${url.origin}${PROTECTED_RESOURCE_PATH}`)
  return list
}

export async function discoverProtectedResource(resourceUrl) {
  for (const candidate of protectedResourceCandidates(resourceUrl)) {
    const result = await getJson(candidate)
    const servers = result.ok ? result.body?.authorization_servers : undefined
    if (Array.isArray(servers) && servers.length > 0) {
      return {
        resource: typeof result.body.resource === 'string' ? result.body.resource : resourceUrl,
        authorizationServers: servers.filter((item) => typeof item === 'string'),
        scopes: Array.isArray(result.body.scopes_supported) ? result.body.scopes_supported : [],
      }
    }
  }
  return null
}

/** Authorization server metadata (RFC 8414 / OIDC discovery). */
export async function discoverAuthorizationServer(issuer) {
  const base = String(issuer).replace(/\/+$/, '')
  for (const path of AS_METADATA_PATHS) {
    const result = await getJson(`${base}${path}`)
    if (result.ok && typeof result.body?.authorization_endpoint === 'string' && typeof result.body?.token_endpoint === 'string') {
      return {
        issuer: result.body.issuer ?? base,
        authorizationEndpoint: result.body.authorization_endpoint,
        tokenEndpoint: result.body.token_endpoint,
        registrationEndpoint: typeof result.body.registration_endpoint === 'string' ? result.body.registration_endpoint : undefined,
        scopes: Array.isArray(result.body.scopes_supported) ? result.body.scopes_supported : [],
        raw: result.body,
      }
    }
  }
  return null
}

/**
 * Dynamic client registration (RFC 7591) for a public PKCE client. Returns
 * undefined when the server does not offer registration; the caller then asks
 * for a client id instead.
 */
export async function registerClient(metadata, { redirectUri, clientName = 'DSH MCP Connector' }) {
  if (!metadata.registrationEndpoint) return undefined
  const result = await getJson(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  if (!result.ok || typeof result.body?.client_id !== 'string') return undefined
  return { clientId: result.body.client_id, raw: result.body }
}

export function buildAuthorizeUrl({ metadata, clientId, redirectUri, state, challenge, resource, scope }) {
  const url = new URL(metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (resource) url.searchParams.set('resource', resource)
  if (scope) url.searchParams.set('scope', scope)
  return url.toString()
}

async function tokenRequest(metadata, params) {
  const response = await fetch(metadata.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  })
  const text = await response.text()
  let body = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  if (!response.ok || body === null) {
    const message = body?.error_description ?? body?.error ?? `HTTP ${response.status}`
    const error = new Error(`授权服务器拒绝了请求：${String(message).slice(0, 300)}`)
    error.code = typeof body?.error === 'string' ? body.error.toUpperCase() : 'OAUTH_TOKEN_FAILED'
    throw error
  }
  return body
}

export async function exchangeCode({ metadata, clientId, code, redirectUri, verifier, resource }) {
  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }
  if (resource) params.resource = resource
  return tokenRequest(metadata, params)
}

export async function refreshAccessToken({ metadata, clientId, refreshToken, resource }) {
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  }
  if (resource) params.resource = resource
  return tokenRequest(metadata, params)
}

const DONE_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>授权完成</title>
<style>body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}
main{max-width:420px;padding:28px 32px;border:1px solid #334155;border-radius:12px;background:#1b2336}
h1{margin:0 0 8px;font-size:16px}p{margin:6px 0;color:#94a3b8}</style></head>
<body><main><h1>授权完成</h1><p id="m">可以回到 DSH 了，这个窗口会自动关闭。</p></main>
<script>setTimeout(() => window.close(), 1200)</script></body></html>`

const FAILED_PAGE = (message) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>授权失败</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}
main{max-width:460px;padding:28px 32px;border:1px solid #7f1d1d;border-radius:12px;background:#1b2336}
h1{margin:0 0 8px;font-size:16px;color:#f87171}code{color:#fca5a5}</style></head>
<body><main><h1>授权失败</h1><p>${message}</p></main></body></html>`

/**
 * Loopback redirect listener (RFC 8252). Binds to 127.0.0.1 on an ephemeral port
 * so the redirect URI never leaves this machine, and resolves exactly one code.
 */
export async function startLoopbackServer({ timeoutMs = 300_000, path = '/callback' } = {}) {
  let resolveCode
  let rejectCode
  const result = new Promise((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      const description = url.searchParams.get('error_description') ?? error
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FAILED_PAGE(description))
      rejectCode(Object.assign(new Error(`授权被拒绝：${description}`), { code: 'OAUTH_DENIED' }))
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FAILED_PAGE('回调缺少 code 或 state'))
      rejectCode(Object.assign(new Error('回调缺少 code 或 state'), { code: 'OAUTH_CALLBACK_INVALID' }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(DONE_PAGE)
    resolveCode({ code, state })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const redirectUri = `http://127.0.0.1:${address.port}${path}`

  const timer = setTimeout(() => {
    rejectCode(Object.assign(new Error('等待授权回调超时'), { code: 'OAUTH_TIMEOUT' }))
  }, timeoutMs)
  timer.unref?.()

  return {
    redirectUri,
    waitForCode: () => result,
    close: () => {
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        // already closed
      }
    },
  }
}
