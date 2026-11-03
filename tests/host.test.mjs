// Host-half integration test for @local/dsh-mcp-connector.
// Runs the real plugin code against a mock Cordis context, a scratch stdio MCP
// server and scratch HTTP endpoints. No browser, no DSH host required.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveExecutable } from '../lib/transport-stdio.js'
import { FileCredentialStore } from '../lib/credential-store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const DATA = path.join(HERE, 'tmp', 'registry')
const SERVER = path.join(HERE, 'echo-server.mjs')

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((error) => results.push({ name, ok: false, error }))
}

function mockCtx({ credentials } = {}) {
  const registered = new Map()
  const effects = []
  const events = []
  const ctx = {
    credentials,
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    get(name) {
      if (name === 'tools') return this.tools
      if (name === 'credentials') return this.credentials
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    emit(name, payload) {
      events.push({ name, payload })
    },
  }
  return { ctx, registered, effects, events }
}

async function freshData() {
  await fs.rm(DATA, { recursive: true, force: true })
  await fs.mkdir(DATA, { recursive: true })
}

const { apply } = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)

async function waitFor(probe, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

const stdioConfig = () => ({ transport: 'stdio', command: process.execPath, args: [SERVER], env: { TEST_TOKEN: 'sk-secret-value' }, cwd: '' })

// ── scratch HTTP endpoints ─────────────────────────────────────────────────────
const httpServers = []
async function startHttp(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  httpServers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

const mcpHttpUrl = await startHttp(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const reply = (result) => {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }
  if (message.method === 'initialize') {
    reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-echo', version: '1.0.0' } })
    return
  }
  if (message.method === 'tools/list') {
    reply({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] })
    return
  }
  if (message.method === 'tools/call') {
    reply({ content: [{ type: 'text', text: 'pong' }] })
    return
  }
  res.writeHead(202).end()
})

const authUrl = await startHttp((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'unauthorized', token: 'sk-should-not-leak-1234567890' }))
})

const brokenUrl = await startHttp((req, res) => {
  res.writeHead(500).end('boom')
})

const notFoundUrl = await startHttp((req, res) => {
  res.writeHead(404).end('nope')
})

try {
  await freshData()
  const { ctx, registered, effects, events } = mockCtx()
  const runtime = apply(ctx, { registry: { dataDir: DATA } })
  await runtime.ready

  await check('Windows 上按 PATHEXT 选启动器（npx 而不是无扩展名的脚本）', () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(path.join(os.tmpdir(), 'resolver-'))
    writeFileSync(path.join(dir, 'demo-tool'), '#!/bin/sh\n')
    writeFileSync(path.join(dir, 'demo-tool.cmd'), '@echo off\n')
    const saved = process.env.PATH
    try {
      process.env.PATH = dir
      const resolved = resolveExecutable('demo-tool')
      assert.equal(path.extname(resolved).toLowerCase(), '.cmd', `resolved=${resolved}`)
    } finally {
      process.env.PATH = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await check('空注册表启动', () => {
    const snapshot = runtime.snapshot()
    assert.equal(snapshot.servers.length, 0)
    assert.equal(snapshot.config.registryEnabled, true)
  })

  let stdioId
  await check('添加 stdio 服务器并连接', async () => {
    const result = await runtime.addServer({ serverName: 'demo', config: stdioConfig() })
    stdioId = result.receipt.id
    assert.equal(result.receipt.action, 'add')
    const state = runtime.snapshot().servers.find((item) => item.id === stdioId)
    assert.equal(state.state, 'ready', `state=${state.state} err=${JSON.stringify(state.lastError)}`)
    assert.equal(state.protocolVersion, '2025-06-18')
    assert.equal(state.toolCount, 4)
  })

  await check('工具以 mcp__<server>__<tool> 注册', () => {
    const names = [...registered.keys()].sort()
    const stable = names.filter((name) => !name.startsWith('mcp__demo__weird_name_'))
    assert.deepEqual(stable, ['mcp__demo__add', 'mcp__demo__echo', 'mcp__demo__fail'])
    // A raw name with characters outside the function-name grammar keeps its
    // readable prefix and gets the identity hash suffix, exactly like the
    // official client, so distinct raw names never collapse.
    assert.ok(names.some((name) => /^mcp__demo__weird_name__[0-9a-f]{12}$/.test(name)), names.join(','))
  })

  await check('工具调用返回内容', async () => {
    const result = await registered.get('mcp__demo__echo').execute({ text: '你好' }, {})
    assert.equal(result.content[0].text, 'echo:你好')
    const rendered = registered.get('mcp__demo__echo').output.render({}, result)
    assert.equal(rendered[0].text, 'echo:你好')
  })

  await check('结构化结果透传', async () => {
    const result = await registered.get('mcp__demo__add').execute({ a: 2, b: 3 }, {})
    assert.deepEqual(result.structuredContent, { sum: 5 })
  })

  await check('工具业务错误与协议错误可区分', async () => {
    await assert.rejects(
      () => registered.get('mcp__demo__fail').execute({}, {}),
      (error) => error.code === 'TOOL_ERROR' && error.phase === 'call' && /这是业务错误/.test(error.message),
    )
  })

  await check('快照被脱敏（env 只给键名）', () => {
    const state = runtime.snapshot().servers.find((item) => item.id === stdioId)
    assert.deepEqual(Object.keys(state.config.env), ['TEST_TOKEN'])
    assert.equal(state.config.env.TEST_TOKEN, '已设置')
    assert.deepEqual(state.credentials.envKeys, ['TEST_TOKEN'])
    assert.ok(!JSON.stringify(runtime.snapshot()).includes('sk-secret-value'))
  })

  await check('连接测试（草稿）不写入注册表', async () => {
    const before = runtime.snapshot().servers.length
    const probe = await runtime.testConnection({ serverName: 'probe', config: stdioConfig() })
    assert.equal(probe.ok, true, JSON.stringify(probe))
    assert.equal(probe.toolCount, 4)
    assert.ok(probe.tools.some((tool) => tool.name === 'echo'))
    assert.equal(runtime.snapshot().servers.length, before)
  })

  await check('行内「测试连接」按 id 探测已保存配置', async () => {
    // Regression: posting only `{ id }` used to be read as a flat draft, which has
    // no transport and failed with CONFIG_INVALID instead of probing.
    const probe = await runtime.testConnection({ id: stdioId })
    assert.equal(probe.ok, true, JSON.stringify(probe.error ?? probe))
    assert.equal(probe.toolCount, 4)
  })

  await check('测试失败返回结构化诊断（command 不存在）', async () => {
    const probe = await runtime.testConnection({
      serverName: 'probe2',
      config: { transport: 'stdio', command: 'definitely-not-a-real-command-xyz', args: [] },
    })
    assert.equal(probe.ok, false)
    assert.equal(probe.error.code, 'COMMAND_NOT_FOUND')
    assert.equal(probe.error.phase, 'config')
  })

  await check('cwd 不存在 → CWD_MISSING', async () => {
    const probe = await runtime.testConnection({
      serverName: 'probe3',
      config: { transport: 'stdio', command: process.execPath, args: [SERVER], cwd: path.join(DATA, 'missing') },
    })
    assert.equal(probe.error.code, 'CWD_MISSING')
    assert.equal(probe.error.phase, 'config')
  })

  await check('HTTP 服务器连接与工具发现', async () => {
    const result = await runtime.addServer({
      serverName: 'httpdemo',
      config: { transport: 'streamable-http', url: mcpHttpUrl, headers: { authorization: 'Bearer sekret-token' } },
    })
    const state = runtime.snapshot().servers.find((item) => item.id === result.receipt.id)
    assert.equal(state.state, 'ready', `state=${state.state} err=${JSON.stringify(state.lastError)}`)
    assert.equal(state.transport.type, 'streamable-http')
    assert.ok(registered.has('mcp__httpdemo__ping'))
    // Header values reach the settings projection so the editor can reveal them;
    // the page masks them by default. Diagnostics stay redacted (next test).
    assert.equal(state.config.headers.authorization, 'Bearer sekret-token')
    await runtime.removeServer(result.receipt.id)
  })

  await check('HTTP 401 → HTTP_AUTH（诊断不含凭据）', async () => {
    const result = await runtime.addServer({
      serverName: 'authdemo',
      config: { transport: 'streamable-http', url: authUrl, headers: { authorization: 'Bearer should-not-leak' } },
    })
    const state = runtime.snapshot().servers.find((item) => item.id === result.receipt.id)
    // With reconnect enabled the state cycles (error → reconnecting); the
    // diagnostic is what proves the failure was classified as auth.
    assert.equal(state.lastError.code, 'HTTP_AUTH')
    assert.equal(state.lastError.phase, 'transport')
    assert.ok(!JSON.stringify(state.lastError).includes('should-not-leak'))
    assert.ok(!JSON.stringify(state.lastError).includes('sk-should-not-leak-1234567890'))
    await runtime.removeServer(result.receipt.id)
  })

  await check('HTTP 5xx → HTTP_SERVER_ERROR', async () => {
    const result = await runtime.addServer({
      serverName: 'brokendemo',
      config: { transport: 'streamable-http', url: brokenUrl, headers: {} },
    })
    const state = runtime.snapshot().servers.find((item) => item.id === result.receipt.id)
    assert.equal(state.lastError.code, 'HTTP_SERVER_ERROR')
    await runtime.removeServer(result.receipt.id)
  })

  await check('HTTP 404 → HTTP_NOT_FOUND', async () => {
    const result = await runtime.addServer({
      serverName: 'missingdemo',
      config: { transport: 'streamable-http', url: notFoundUrl, headers: {} },
    })
    const state = runtime.snapshot().servers.find((item) => item.id === result.receipt.id)
    assert.equal(state.lastError.code, 'HTTP_NOT_FOUND')
    await runtime.removeServer(result.receipt.id)
  })

  await check('连接被拒绝 → NETWORK_TCP', async () => {
    const result = await runtime.testConnection({
      serverName: 'neterr',
      config: { transport: 'streamable-http', url: 'http://127.0.0.1:45999/mcp', headers: {} },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NETWORK_TCP')
  })

  await check('禁用后断开且工具注销，配置保留', async () => {
    await runtime.setDisabled(stdioId, true)
    const state = runtime.snapshot().servers.find((item) => item.id === stdioId)
    assert.equal(state.state, 'disabled')
    assert.equal(registered.has('mcp__demo__echo'), false)
    assert.equal(state.toolCount, 0)
    assert.equal(state.config.command, process.execPath)
  })

  await check('重新启用后恢复连接与工具', async () => {
    await runtime.setDisabled(stdioId, false)
    const state = runtime.snapshot().servers.find((item) => item.id === stdioId)
    assert.equal(state.state, 'ready')
    assert.equal(registered.has('mcp__demo__echo'), true)
  })

  await check('编辑连接参数热更新（不重挂插件）', async () => {
    const before = runtime.snapshot().servers.find((item) => item.id === stdioId)
    await runtime.updateServer(stdioId, { config: { ...stdioConfig(), env: { TEST_TOKEN: 'other' } } })
    const after = runtime.snapshot().servers.find((item) => item.id === stdioId)
    assert.equal(after.state, 'ready')
    assert.notEqual(after.stats.connectedAt, before.stats.connectedAt)
    assert.equal(after.credentials.envKeys[0], 'TEST_TOKEN')
  })

  await check('serverName 可以改名，工具前缀随之更新', async () => {
    const added = await runtime.addServer({ serverName: 'renamable', config: stdioConfig() })
    const id = added.receipt.id
    assert.ok(registered.has('mcp__renamable__echo'), 'registered under the original name')

    const renamed = await runtime.updateServer(id, { serverName: 'renamed_ok', config: stdioConfig() })
    assert.equal(renamed.server.serverName, 'renamed_ok')
    assert.match(renamed.receipt.message, /改名/)
    assert.equal(registered.has('mcp__renamable__echo'), false, 'old prefix released')
    assert.ok(registered.has('mcp__renamed_ok__echo'), 'registered under the new prefix')

    // A name that is already taken is refused.
    await assert.rejects(
      () => runtime.updateServer(id, { serverName: 'demo', config: stdioConfig() }),
      (error) => error.code === 'SERVER_NAME_CONFLICT',
    )
    await runtime.removeServer(id)
  })

  await check('仅重试单条连接', async () => {
    const result = await runtime.retryServer(stdioId)
    assert.equal(result.receipt.action, 'retry')
    assert.equal(result.server.state, 'ready')
  })

  await check('导入四种 JSON 结构', async () => {
    const claude = await runtime.importJson({
      text: JSON.stringify({ mcpServers: { imp1: { command: process.execPath, args: [SERVER] } } }),
    })
    assert.equal(claude.ok, true)
    assert.equal(claude.dialect, 'mcpServers-map')
    const vscode = await runtime.importJson({
      text: JSON.stringify({ servers: { imp2: { type: 'stdio', command: process.execPath, args: [SERVER] } } }),
    })
    assert.equal(vscode.dialect, 'vscode-map')
    const bare = await runtime.importJson({
      text: JSON.stringify({ imp3: { url: mcpHttpUrl } }),
    })
    assert.equal(bare.dialect, 'bare-map')
    const single = await runtime.importJson({
      text: JSON.stringify({ name: 'imp4', command: process.execPath, args: [SERVER] }),
    })
    assert.equal(single.dialect, 'single')
    const array = await runtime.importJson({
      text: JSON.stringify([{ serverName: 'imp5', command: process.execPath, args: [SERVER] }]),
    })
    assert.equal(array.dialect, 'array')
    const names = runtime.snapshot().servers.map((item) => item.serverName)
    for (const name of ['imp1', 'imp2', 'imp3', 'imp4', 'imp5']) assert.ok(names.includes(name), name)
  })

  await check('导入：友好名字自动转成前缀，缺 command 仍逐条报错', async () => {
    const before = runtime.snapshot().servers.length
    const result = await runtime.importJson({
      text: JSON.stringify({
        mcpServers: {
          good: { command: process.execPath, args: [SERVER] },
          'bad name!': { command: process.execPath },
          noCommand: { args: ['x'] },
        },
      }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.written, false)
    assert.equal(result.rejected.length, 1, "only the missing command is rejected")
    assert.equal(result.accepted.length, 2, "the friendly name is accepted")
    assert.ok(result.rejected.some((item) => item.code === 'CONFIG_INVALID'), 'codes: ' + JSON.stringify(result.rejected.map((item) => item.code)))
    assert.equal(runtime.snapshot().servers.length, before)
  })

  await check('字段变体（type/transport/url/env/args 字符串）', async () => {
    const result = await runtime.importJson({
      text: JSON.stringify({
        mcpServers: {
          variant1: { type: 'stdio', command: process.execPath, env: { A: 1 }, args: '--foo bar' },
          variant2: { transport: 'http', url: mcpHttpUrl, headers: { 'X-Api-Key': 'k' } },
        },
      }),
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const state = runtime.snapshot().servers.find((item) => item.serverName === 'variant1')
    assert.deepEqual(state.config.args, ['--foo', 'bar'])
    assert.equal(state.config.env.A, '已设置')
    const http2 = runtime.snapshot().servers.find((item) => item.serverName === 'variant2')
    assert.equal(http2.config.transport, 'streamable-http')
  })

  await check('全量覆盖导入原子增删改', async () => {
    const before = runtime.snapshot().servers.map((item) => item.serverName)
    const result = await runtime.importJson({
      mode: 'replace',
      text: JSON.stringify({
        mcpServers: {
          demo: { command: process.execPath, args: [SERVER] },
          only: { command: process.execPath, args: [SERVER] },
        },
      }),
    })
    assert.equal(result.ok, true)
    const after = runtime.snapshot().servers.map((item) => item.serverName)
    assert.deepEqual(after.sort(), ['demo', 'only'])
    assert.ok(before.includes('imp1'))
    assert.ok(result.receipt.removed.includes('imp1'))
  })

  await check('导出三种结构', () => {
    const defaultShape = runtime.exportJson()
    assert.ok(defaultShape.document.mcpServers)
    const map = runtime.exportJson({ format: 'map' })
    assert.equal(map.document.mcpServers, undefined)
    assert.ok(map.document.demo)
    const array = runtime.exportJson({ format: 'array' })
    assert.ok(Array.isArray(array.document))
    assert.ok(array.document.every((item) => item.serverName))
  })

  await check('SSE 分帧兼容 CRLF 与跨块边界', async () => {
    const { parseSseStream } = await import(pathToFileURL(path.join(ROOT, 'lib', 'transport-http.js')).href)
    const events = []
    // Modao answers with CRLF line endings; matching only "\n\n" drops every event.
    const rest = parseSseStream(
      'event: message\r\ndata: {"a":1}\r\n\r\nevent: message\r\ndata: {"b":2}\r\n\r\n',
      (event) => events.push(event),
    )
    assert.equal(rest, '')
    assert.equal(events.length, 2)
    assert.equal(events[0].data, '{"a":1}')
    assert.equal(events[1].data, '{"b":2}')

    // A boundary split across two reads must not emit a partial event.
    const first = parseSseStream('event: message\r\ndata: {"c":3}\r\n\r', (event) => events.push(event))
    assert.equal(events.length, 2)
    parseSseStream(`${first}\n`, (event) => events.push(event))
    assert.equal(events.length, 3)
    assert.equal(events[2].data, '{"c":3}')

    // LF-only servers keep working.
    const lf = []
    parseSseStream('data: {"d":4}\n\n', (event) => lf.push(event))
    assert.equal(lf.length, 1)
    assert.equal(lf[0].data, '{"d":4}')
  })

  await check('凭据引用：解析、缺失诊断与不落盘', async () => {
    const { collectCredentialRefs, resolveCredentials, describeCredentials } = await import(
      pathToFileURL(path.join(ROOT, 'lib', 'credentials.js')).href
    )
    const config = {
      transport: 'streamable-http',
      url: 'https://example.invalid/mcp',
      headers: { 'modao-token': '${credential:MODAO_TOKEN}', 'x-plain': 'literal' },
    }
    assert.deepEqual(collectCredentialRefs(config), ['MODAO_TOKEN'])

    const resolved = await resolveCredentials(config, { resolve: async () => 'secret-value' })
    assert.equal(resolved.headers['modao-token'], 'secret-value')
    assert.equal(resolved.headers['x-plain'], 'literal')
    // The source config keeps the placeholder.
    assert.equal(config.headers['modao-token'], '${credential:MODAO_TOKEN}')

    await assert.rejects(
      () => resolveCredentials(config, { resolve: async () => undefined }),
      (error) => error.code === 'CREDENTIAL_MISSING' && error.detail.refs.includes('MODAO_TOKEN'),
    )

    const status = await describeCredentials(config, {
      describe: async () => ({ configured: false }),
      env: { MODAO_TOKEN: 'from-env' },
    })
    assert.equal(status[0].configured, true)
    assert.equal(status[0].source, 'environment')
  })

  await check('凭据引用：连上后配置里仍是占位符', async () => {
    process.env.TEST_CRED = 'resolved-at-connect'
    try {
      const result = await runtime.addServer({
        serverName: 'cred',
        config: { transport: 'stdio', command: process.execPath, args: [SERVER], env: { TEST_CRED: '${credential:TEST_CRED}' } },
      })
      const state = runtime.snapshot().servers.find((item) => item.id === result.receipt.id)
      assert.equal(state.state, 'ready', JSON.stringify(state.lastError))
      assert.equal(state.config.env.TEST_CRED, '已设置')
      assert.deepEqual(state.credentialRefs, ['TEST_CRED'])
      const onDisk = JSON.parse(await fs.readFile(path.join(DATA, 'registry.json'), 'utf8'))
      const record = onDisk.servers.find((item) => item.serverName === 'cred')
      assert.equal(record.config.env.TEST_CRED, '${credential:TEST_CRED}')
      assert.ok(!JSON.stringify(onDisk).includes('resolved-at-connect'))
      const status = await runtime.credentialStatus(result.receipt.id)
      assert.equal(status[0].refs[0].configured, true)
      await runtime.removeServer(result.receipt.id)
    } finally {
      delete process.env.TEST_CRED
    }
  })

  await check('凭据缺失时探测返回 CREDENTIAL_MISSING', async () => {
    const probe = await runtime.testConnection({
      serverName: 'cred-missing',
      config: {
        transport: 'streamable-http',
        url: 'https://example.invalid/mcp',
        headers: { 'modao-token': '${credential:NOT_CONFIGURED_ANYWHERE}' },
      },
    })
    assert.equal(probe.ok, false)
    assert.equal(probe.error.code, 'CREDENTIAL_MISSING')
    assert.equal(probe.error.phase, 'config')
  })

  await check('没有凭据服务时写入本地凭据文件，重启后仍可用', async () => {
    const stored = await runtime.putCredential('LOCAL_SECRET', 's3cret-value')
    assert.equal(stored.stored, true)

    const file = path.join(DATA, 'credentials.json')
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(onDisk.LOCAL_SECRET, 's3cret-value')

    // A fresh runtime with the same data dir resolves it without the platform
    // credential service: that is what a restart looks like.
    const { ctx: ctxFresh } = mockCtx()
    const store = new FileCredentialStore({ dir: DATA })
    assert.equal(await store.get('LOCAL_SECRET'), 's3cret-value')
    const runtimeFresh = apply(ctxFresh, { registry: { dataDir: DATA } })
    await runtimeFresh.ready
    await runtimeFresh.dispose()
  })

  await check('持久化：重新加载注册表', async () => {
    const onDisk = JSON.parse(await fs.readFile(path.join(DATA, 'registry.json'), 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.ok(onDisk.servers.length >= 2)
    const { ctx: ctx2, registered: registered2 } = mockCtx()
    const runtime2 = apply(ctx2, { registry: { dataDir: DATA } })
    await runtime2.ready
    await new Promise((resolve) => setTimeout(resolve, 300))
    const names = runtime2.snapshot().servers.map((item) => item.serverName)
    assert.ok(names.includes('demo'), names.join(','))
    assert.ok(registered2.has('mcp__demo__echo'))
    await runtime2.dispose()
  })

  await check('删除后连接与工具一起释放', async () => {
    const result = await runtime.removeServer(stdioId)
    assert.equal(result.receipt.action, 'remove')
    assert.equal(runtime.snapshot().servers.some((item) => item.id === stdioId), false)
    assert.equal([...registered.keys()].some((name) => name.startsWith('mcp__demo__')), false)
  })

  await check('卸载时逆序清理全部资源', async () => {
    await runtime.dispose()
    assert.equal(registered.size, 0)
    for (const dispose of effects) if (typeof dispose === 'function') dispose()
    assert.equal(runtime.snapshot().servers.length, 0)
  })

  await check('健康检查与统计', () => {
    const health = runtime.health()
    assert.equal(typeof health.ok, 'boolean')
    assert.equal(typeof health.uptimeMs, 'number')
    assert.equal(health.servers, 0)
  })


  await check('OAuth 授权：发现 → 注册 → 授权码 → 换 token → 连接 → 撤销', async () => {
    const oauthState = { access: '', refresh: '' }
    const oauthBase = await startHttp(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const json = (body, status = 200, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json({ resource: `${oauthBase}/mcp`, authorization_servers: [oauthBase] })
        return
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json({
          issuer: oauthBase,
          authorization_endpoint: `${oauthBase}/authorize`,
          token_endpoint: `${oauthBase}/token`,
          registration_endpoint: `${oauthBase}/register`,
          scopes_supported: [],
        })
        return
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        json({ client_id: 'client-1', token_endpoint_auth_method: 'none' })
        return
      }
      if (url.pathname === '/authorize') {
        const redirect = url.searchParams.get('redirect_uri')
        const st = url.searchParams.get('state')
        assert.ok(url.searchParams.get('code_challenge'), 'PKCE challenge forwarded')
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
        res.writeHead(302, { location: `${redirect}?code=code-1&state=${encodeURIComponent(st)}` })
        res.end()
        return
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        if (form.get('grant_type') === 'authorization_code') {
          assert.equal(form.get('code'), 'code-1')
          assert.ok(form.get('code_verifier'), 'PKCE verifier sent')
          oauthState.access = 'access-1'
          oauthState.refresh = 'refresh-1'
          json({ access_token: oauthState.access, refresh_token: oauthState.refresh, token_type: 'Bearer', expires_in: 3600 })
          return
        }
        json({ error: 'unsupported_grant_type' }, 400)
        return
      }
      if (url.pathname === '/mcp' && req.method === 'POST') {
        if (oauthState.access === '' || req.headers.authorization !== `Bearer ${oauthState.access}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_token' }))
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const reply = (result) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
        }
        if (message.method === 'initialize') {
          reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauth-echo', version: '1.0.0' } })
          return
        }
        if (message.method === 'tools/list') {
          reply({ tools: [{ name: 'whoami', description: 'whoami', inputSchema: { type: 'object' } }] })
          return
        }
        res.writeHead(202).end()
        return
      }
      res.writeHead(404).end()
    })

    // The shared runtime is disposed by an earlier case; this flow needs its own.
    await freshData()
    const oauthRuntime = apply(ctx, { registry: { dataDir: DATA } })
    await oauthRuntime.ready

    const added = await oauthRuntime.addServer({
      serverName: 'oauthdemo',
      config: { transport: 'streamable-http', url: `${oauthBase}/mcp` },
    })
    const id = added.receipt.id
    const before = await waitFor(() => {
      const item = oauthRuntime.snapshot().servers.find((entry) => entry.id === id)
      return item && !['draft', 'connecting', 'initializing'].includes(item.state) ? item : null
    }, 4000)
    assert.ok(before, 'server settles before authorization')
    assert.equal(before.oauth.status, 'none')
    assert.equal(before.oauth.authorized, false)
    assert.notEqual(before.state, 'ready', 'unauthorized server does not connect')
    assert.equal(before.lastError?.code, 'HTTP_AUTH', 'fails with an auth diagnostic')

    const begun = await oauthRuntime.beginOAuth(id)
    assert.match(begun.url, /response_type=code/)
    assert.match(begun.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const authorized = await fetch(begun.url, { redirect: 'manual' })
    const location = authorized.headers.get('location')
    assert.ok(location?.startsWith(begun.redirectUri), 'redirects back to the loopback listener')
    const callback = await fetch(location)
    assert.equal(callback.status, 200)

    const ready = await waitFor(() => {
      const item = oauthRuntime.snapshot().servers.find((entry) => entry.id === id)
      return item?.oauth?.authorized === true && item.state === 'ready' ? item : null
    }, 6000)
    assert.ok(ready, 'server connects after authorization')
    assert.ok(registered.has('mcp__oauthdemo__whoami'), 'tools registered after authorization')

    const revoked = await oauthRuntime.revokeOAuth(id)
    assert.equal(revoked.oauth.status, 'none')
    assert.equal(oauthRuntime.snapshot().servers.find((entry) => entry.id === id).oauth.authorized, false)
    await oauthRuntime.removeServer(id)
    await oauthRuntime.dispose()
  })

  await check('事件通过 ctx.emit 广播', () => {
    assert.ok(events.some((event) => event.name === 'mcp-connector/state'))
  })
} finally {
  for (const server of httpServers) server.close()
}

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  if (!item.ok) console.log(`      ${item.error?.stack?.split('\n').slice(0, 4).join('\n      ') ?? item.error}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
