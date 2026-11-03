// API-bridge test: mounts the real management routes on a fake web server and
// speaks to them the way the Settings page does (GET snapshot, POST actions,
// unknown action, method guard, import rejection envelope).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const DATA = path.join(HERE, 'tmp', 'api-registry')
const SERVER = path.join(HERE, 'echo-server.mjs')

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

const registered = new Map()
const ctx = {
  tools: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  get(name) {
    return name === 'webServer' ? webServer : undefined
  },
  effect(fn) {
    return fn()
  },
  emit() {},
}

const routes = []
const webServer = {
  register(spec) {
    routes.push(spec)
    return () => {}
  },
}

const { apply } = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
await fs.rm(DATA, { recursive: true, force: true })
const runtime = apply(ctx, { registry: { dataDir: DATA } })
await runtime.ready

const routeOf = (suffix) => routes.find((route) => route.path === `/dsh-mcp-connector/${suffix}`)

/** Minimal Request-like object over a JSON body. */
function makeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: '/dsh-mcp-connector/api',
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Minimal Response-like object that records status and parsed payload. */
function makeRes() {
  const record = { status: 0, headers: {}, body: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk !== undefined) record.body += String(chunk)
    },
    get json() {
      return JSON.parse(record.body)
    },
  }
}

async function callRoute(suffix, method, body) {
  const route = routeOf(suffix)
  assert.ok(route, `route ${suffix} registered`)
  const res = makeRes()
  await route.handler(makeReq(method, body), res)
  return res
}

await check('三条路由注册在固定前缀上', () => {
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/dsh-mcp-connector/api',
    '/dsh-mcp-connector/config',
    '/dsh-mcp-connector/health',
  ])
  assert.ok(routes.every((route) => route.kind === 'exact'))
})

await check('GET /api 返回完整快照', async () => {
  const res = await callRoute('api', 'GET')
  assert.equal(res.record.status, 200)
  assert.equal(res.json.ok, true)
  assert.ok(Array.isArray(res.json.data.servers))
  assert.ok(res.json.data.config.allowedTransports.length > 0)
  assert.equal(res.record.headers['cache-control'], 'no-store')
})

await check('POST addServer 返回回执与服务器视图', async () => {
  const res = await callRoute('api', 'POST', {
    action: 'addServer',
    payload: { serverName: 'bridge', config: { transport: 'stdio', command: process.execPath, args: [SERVER] } },
  })
  assert.equal(res.record.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.data.receipt.action, 'add')
  assert.equal(res.json.data.server.state, 'ready')
  assert.ok(registered.has('mcp__bridge__echo'))
})

await check('GET /health 反映状态与计数', async () => {
  const res = await callRoute('health', 'GET')
  assert.equal(res.json.ok, true)
  assert.equal(res.json.data.servers, 1)
  assert.equal(res.json.data.ready, 1)
  assert.equal(res.json.data.states.bridge, 'ready')
})

await check('GET /config 只暴露部署策略', async () => {
  const res = await callRoute('config', 'GET')
  assert.equal(res.json.data.registryEnabled, true)
  assert.equal(res.json.data.dataDir, DATA)
  assert.equal(res.json.data.servers, undefined)
})

await check('未知动作 404', async () => {
  const res = await callRoute('api', 'POST', { action: 'nope' })
  assert.equal(res.record.status, 404)
  assert.equal(res.json.error.code, 'UNKNOWN_ACTION')
})

await check('不支持的方法 405（含 Allow）', async () => {
  const res = await callRoute('api', 'PUT')
  assert.equal(res.record.status, 405)
  const health = await callRoute('health', 'DELETE')
  assert.equal(health.record.status, 405)
  assert.equal(health.record.headers.allow, 'GET, HEAD')
})

await check('非法 JSON 请求体 400', async () => {
  const route = routeOf('api')
  const res = makeRes()
  const req = {
    method: 'POST',
    url: '/dsh-mcp-connector/api',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{not json')
    },
  }
  await route.handler(req, res)
  assert.equal(res.record.status, 400)
  assert.equal(res.json.error.code, 'INVALID_JSON')
})

await check('导入校验失败返回逐条原因而非写入', async () => {
  const res = await callRoute('api', 'POST', {
    action: 'importJson',
    payload: { text: JSON.stringify({ mcpServers: { 'bad name!': { command: 'x' } } }) },
  })
  assert.equal(res.record.status, 200)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.error.detail.written, false)
  assert.equal(res.json.error.detail.rejected[0].code, 'SERVER_NAME_INVALID')
  const snapshot = await callRoute('api', 'GET')
  assert.equal(snapshot.json.data.servers.length, 1)
})

await check('actions 列表覆盖页面用到的全部动作', async () => {
  for (const action of ['state', 'addServer', 'updateServer', 'removeServer', 'setDisabled', 'retryServer', 'refreshServer', 'testConnection', 'importJson', 'exportJson', 'credentialStatus', 'setCredential', 'unsetCredential', 'health']) {
    const res = await callRoute('api', 'POST', { action: 'definitely-not-' + action })
    assert.equal(res.json.error.code, 'UNKNOWN_ACTION', action)
  }
  const exportRes = await callRoute('api', 'POST', { action: 'exportJson', payload: { format: 'array' } })
  assert.equal(exportRes.json.ok, true)
  assert.ok(Array.isArray(exportRes.json.data.document))
})

await check('凭据状态随快照返回；无平台凭据服务时落盘本地', async () => {
  const snapshot = await callRoute('api', 'GET')
  assert.ok(Array.isArray(snapshot.json.data.credentials))
  assert.equal(snapshot.json.data.credentials[0].serverName, 'bridge')
  assert.deepEqual(snapshot.json.data.credentials[0].refs, [])
  const res = await callRoute('api', 'POST', { action: 'setCredential', payload: { ref: 'DEMO_REF', value: 'x' } })
  assert.equal(res.json.ok, true, 'stored locally when the platform service is absent')
  assert.equal(res.json.data.stored, true)
})

await check('删除后 health 归零', async () => {
  const snapshot = await callRoute('api', 'GET')
  const id = snapshot.json.data.servers[0].id
  const res = await callRoute('api', 'POST', { action: 'removeServer', payload: { id } })
  assert.equal(res.json.data.receipt.action, 'remove')
  const health = await callRoute('health', 'GET')
  assert.equal(health.json.data.servers, 0)
  assert.equal(registered.size, 0)
  await runtime.dispose()
  await fs.rm(DATA, { recursive: true, force: true })
})

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  if (!item.ok) console.log(`      ${item.error?.stack?.split('\n').slice(0, 4).join('\n      ')}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
