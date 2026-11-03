// Client-half render test: runs client.js in a tiny React runtime with a mocked
// same-origin API, then drives the page (list → editor → probe → save → delete →
// import → export) the way a user would.
//
// This is not a browser: it exists to prove the component tree builds, hooks are
// called legally, every string key resolves, and each action reaches the right
// endpoint with the right payload.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(path.dirname(HERE), 'client.js')

// ── mini React ────────────────────────────────────────────────────────────────
const Fragment = Symbol('Fragment')
const hookStore = new Map()
const pendingEffects = []
let currentInstance = null
let hookIndex = 0

function instanceKeyFor() {
  return currentInstance
}

function h(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return { type, props: { ...(props ?? {}), ...(flat === undefined ? {} : { children: flat }) } }
}

const React = {
  createElement: h,
  Fragment,
  useState(initial) {
    const key = `${instanceKeyFor()}#${hookIndex++}`
    if (!hookStore.has(key)) hookStore.set(key, typeof initial === 'function' ? initial() : initial)
    const set = (next) => {
      hookStore.set(key, typeof next === 'function' ? next(hookStore.get(key)) : next)
      schedule()
    }
    return [hookStore.get(key), set]
  },
  useRef(initial) {
    const key = `${instanceKeyFor()}#${hookIndex++}`
    if (!hookStore.has(key)) hookStore.set(key, { current: initial })
    return hookStore.get(key)
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useEffect(fn, deps) {
    const key = `effect:${instanceKeyFor()}#${hookIndex++}`
    if (hookStore.has(key)) return
    hookStore.set(key, deps)
    pendingEffects.push(fn)
  },
  useMemo(factory) {
    hookIndex += 1
    return factory()
  },
  useId() {
    hookIndex += 1
    return 'id'
  },
}

// ── render runtime ────────────────────────────────────────────────────────────
let root = null
let rootElement = null
let dirty = false
function schedule() {
  dirty = true
}

function renderNode(node, keyPath = '0') {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) {
    return { array: true, children: node.map((child, index) => renderNode(child, `${keyPath}.${index}`)).filter(Boolean) }
  }
  if (typeof node.type === 'function') {
    const previous = currentInstance
    const previousIndex = hookIndex
    currentInstance = keyPath
    hookIndex = 0
    try {
      const output = node.type(node.props ?? {})
      return renderNode(output, keyPath)
    } finally {
      currentInstance = previous
      hookIndex = previousIndex
    }
  }
  if (node.type === Fragment) return renderNode(node.props?.children, keyPath)
  const renderedChildren = renderNode(node.props?.children, keyPath)
  const children = renderedChildren === null
    ? []
    : renderedChildren.array === true
      ? renderedChildren.children
      : [renderedChildren]
  return { type: node.type, props: node.props ?? {}, children }
}

function textOf(tree) {
  if (tree === null || tree === undefined) return ''
  let text = tree.text ?? ''
  for (const child of tree.children ?? []) text += textOf(child)
  return text
}

function findAll(tree, predicate, found = []) {
  if (tree === null || tree === undefined) return found
  if (predicate(tree)) found.push(tree)
  for (const child of tree.children ?? []) findAll(child, predicate, found)
  return found
}

function byText(tree, text) {
  const matches = findAll(tree, (node) => (textOf(node).trim() === text) && node.props?.onClick !== undefined)
  return matches.at(-1)
}

function byPlaceholder(tree, placeholder) {
  return findAll(tree, (node) => node.props?.placeholder === placeholder)[0]
}

function byLabel(tree, label) {
  // Field() renders <label class="mc-label">…</label> followed by the control.
  const fields = findAll(tree, (node) => node.props?.className === 'mc-field' || node.props?.className === 'mc-field mc-field-full')
  for (const field of fields) {
    const texts = findAll(field, (node) => node.text !== undefined).map((node) => node.text)
    if (!texts.includes(label)) continue
    const control = findAll(field, (node) => ['input', 'textarea', 'select'].includes(node.type))[0]
    if (control) return control
  }
  return undefined
}

/** Run effects registered during the last render pass. */
function drainEffects() {
  while (pendingEffects.length > 0) {
    const fn = pendingEffects.shift()
    try {
      fn()
    } catch (error) {
      throw error
    }
  }
}

async function flush() {
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    drainEffects()
    if (!dirty) break
    dirty = false
    root = renderNode(rootElement)
    drainEffects()
  }
}

/** Re-render from the same root element after a click handler changed state. */
function rerender() {
  dirty = false
  root = renderNode(rootElement)
  drainEffects()
}

// ── mocked API ────────────────────────────────────────────────────────────────
const calls = []
let snapshot = {
  config: {
    enabled: true,
    registryEnabled: true,
    persist: true,
    dataDir: 'D:\\DSH_Harness\\home\\mcp-connector',
    defaultTimeoutMs: 30000,
    probeTimeoutMs: 10000,
    toolCallTimeoutMs: 60000,
    allowedTransports: ['stdio', 'streamable-http'],
    exposeTools: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
    probeIntervalMs: 0,
  },
  servers: [],
  stats: { total: 0, ready: 0, degraded: 0, error: 0, disabled: 0, connecting: 0, tools: 0, toolCalls: 0, toolErrors: 0, startedAt: new Date().toISOString(), uptimeMs: 1000, successRate: null },
  generatedAt: new Date().toISOString(),
}

const handlers = {
  testConnection(payload) {
    if (payload.id !== undefined) {
      return {
        ok: true,
        protocolVersion: '2025-06-18',
        transport: { type: 'stdio', command: 'node' },
        tools: [{ name: 'echo', description: '回显' }],
        capabilities: { tools: {} },
        elapsedMs: 42,
        warnings: ['tools/list 返回空列表：连接有效'],
      }
    }
    return {
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND', phase: 'config', message: '找不到可执行文件：nope', detail: { command: 'nope' } },
      stderr: ['line one'],
    }
  },
  addServer(payload) {
    const server = {
      id: 'srv-new',
      serverName: payload.serverName,
      disabled: Boolean(payload.disabled),
      state: 'ready',
      stateLabel: '就绪',
      config: { transport: payload.config.transport, command: payload.config.command, args: payload.config.args ?? [], cwd: null, env: {} },
      transport: { type: 'stdio' },
      protocolVersion: '2025-06-18',
      capabilities: ['tools'],
      serverInfo: { name: 'echo', version: '1' },
      tools: [{ name: 'echo', publicName: `mcp__${payload.serverName}__echo`, description: '回显' }],
      toolCount: 1,
      notes: [],
      lastError: null,
      lastSuccessAt: new Date().toISOString(),
      stats: { attempts: 1, reconnects: 0, toolCalls: 0, toolErrors: 0, connectedAt: Date.now(), uptimeMs: 5 },
    }
    snapshot = { ...snapshot, servers: [...snapshot.servers, server] }
    return { receipt: { action: 'add', at: new Date().toISOString(), id: server.id, serverName: server.serverName, state: 'ready', message: '已添加服务器；连接结果见状态' }, server }
  },
  updateServer() {
    return { receipt: { action: 'update', message: '已更新；连接按需热更新' } }
  },
  setDisabled(payload) {
    snapshot = {
      ...snapshot,
      servers: snapshot.servers.map((item) => (item.id === payload.id ? { ...item, disabled: payload.disabled, state: payload.disabled ? 'disabled' : 'ready', stateLabel: payload.disabled ? '已禁用' : '就绪' } : item)),
    }
    return { receipt: { action: payload.disabled ? 'disable' : 'enable', message: payload.disabled ? '已禁用：连接断开，配置保留' : '已启用：正在连接' } }
  },
  retryServer() {
    return { receipt: { action: 'retry', message: '已重试该连接' } }
  },
  removeServer(payload) {
    snapshot = { ...snapshot, servers: snapshot.servers.filter((item) => item.id !== payload.id) }
    return { receipt: { action: 'remove', message: '已删除 demo，其工具已注销' } }
  },
  importJson(payload) {
    if (payload.text.includes('bad')) {
      const failure = new Error('1 条未通过校验，本次没有写入任何条目')
      failure.code = 'IMPORT_REJECTED'
      failure.detail = {
        ok: false,
        written: false,
        dialect: 'mcpServers-map',
        accepted: ['good'],
        rejected: [{ index: 1, name: 'bad name!', code: 'SERVER_NAME_INVALID', message: 'serverName 必须匹配 [A-Za-z0-9_-]{1,32}' }],
        message: '1 条未通过校验，本次没有写入任何条目',
      }
      throw failure
    }
    return {
      ok: true,
      written: true,
      mode: payload.mode,
      dialect: 'mcpServers-map',
      accepted: ['imported'],
      rejected: [],
      receipt: { action: 'import', message: '合并导入完成：新增 1、更新 0、删除 0' },
    }
  },
  exportJson(payload) {
    return { format: payload.format, count: snapshot.servers.length, document: payload.format === 'array' ? [{ serverName: 'demo' }] : { mcpServers: { demo: { command: 'node' } } } }
  },
  setCredential(payload) {
    return { ref: payload.ref, stored: true }
  },
}

async function fetchMock(url, init = {}) {
  if (!String(url).includes('/dsh-mcp-connector/api')) {
    throw new Error(`unexpected fetch ${url}`)
  }
  if (init.method === 'POST') {
    const body = JSON.parse(init.body)
    calls.push({ action: body.action, payload: body.payload })
    const handler = handlers[body.action]
    if (!handler) throw new Error(`no handler for ${body.action}`)
    let payload
    try {
      payload = { ok: true, data: handler(body.payload ?? {}) }
    } catch (error) {
      payload = { ok: false, error: { code: error.code ?? 'ACTION_FAILED', phase: 'config', message: error.message, detail: error.detail } }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, data: snapshot }) }
}

// ── boot the bundle ───────────────────────────────────────────────────────────
const source = await fs.readFile(CLIENT, 'utf8')
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { captured = mod } } },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
    head: { appendChild() {} },
  },
  fetch: fetchMock,
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  console,
  Intl,
  JSON,
  Date,
  Number,
  String,
  Object,
  Array,
  Promise,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.equal(captured?.id, '@local/dsh-mcp-connector')
const bundle = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
assert.equal(Array.from(bundle.inject).join(','), 'slots')
assert.equal(typeof bundle.apply, 'function')

let registration = null
const effects = []
const ctx = {
  slots: {
    inject(name, factory) {
      assert.equal(name, 'settings.section')
      registration = factory()
    },
    register(options, component) {
      return { options, component, dispose() {} }
    },
  },
  get: () => undefined,
  effect(fn) {
    effects.push(fn())
  },
}

bundle.apply(ctx)
assert.ok(registration, 'page registered into settings.section')
assert.equal(registration.options.id, 'mcp-connector')
assert.equal(registration.options.order, 60)
assert.equal(registration.options.label(), 'MCP Connector')

function mount() {
  hookStore.clear()
  pendingEffects.length = 0
  currentInstance = 'root'
  hookIndex = 0
  rootElement = registration.component({})
  dirty = false
  root = renderNode(rootElement)
  drainEffects()
  return root
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

// ── scenarios ─────────────────────────────────────────────────────────────────
await check('空注册表渲染标题、统计与空态', async () => {
  root = mount()
  await flush()
  const text = textOf(root)
  assert.match(text, /MCP Connector/)
  assert.match(text, /还没有 MCP 服务器/)
  assert.match(text, /部署策略/)
  assert.match(text, /运行时注册表开启/)
})

await check('列表展示状态徽标、最近成功与错误摘要', async () => {
  snapshot = {
    ...snapshot,
    servers: [
      {
        id: 'a1',
        serverName: 'demo',
        disabled: false,
        state: 'ready',
        stateLabel: '就绪',
        config: { transport: 'stdio', command: 'node', args: ['server.js'], cwd: null, env: { TOKEN: '已设置' } },
        transport: { type: 'stdio', command: 'node' },
        protocolVersion: '2025-06-18',
        capabilities: ['tools'],
        serverInfo: { name: 'echo', version: '1' },
        tools: [{ name: 'echo', publicName: 'mcp__demo__echo', description: '回显' }],
        toolCount: 1,
        notes: [],
        lastError: null,
        lastSuccessAt: '2026-11-02T10:00:00.000Z',
        stats: { attempts: 2, reconnects: 1, toolCalls: 3, toolErrors: 0, connectedAt: Date.now(), uptimeMs: 100 },
      },
      {
        id: 'a2',
        serverName: 'broken',
        disabled: false,
        state: 'error',
        stateLabel: '错误',
        config: { transport: 'streamable-http', url: 'https://example.com/mcp', headers: { authorization: '••••' } },
        transport: { type: 'streamable-http' },
        protocolVersion: null,
        capabilities: [],
        serverInfo: null,
        tools: [],
        toolCount: 0,
        notes: [],
        lastError: { code: 'HTTP_AUTH', phase: 'transport', message: '鉴权失败（HTTP 401）', detail: { status: 401 }, at: new Date().toISOString() },
        lastSuccessAt: null,
        stats: { attempts: 3, reconnects: 2, toolCalls: 0, toolErrors: 0, connectedAt: null, uptimeMs: 0 },
      },
    ],
    stats: { total: 2, ready: 1, degraded: 0, error: 1, disabled: 0, connecting: 0, tools: 1, toolCalls: 3, toolErrors: 0, startedAt: new Date().toISOString(), uptimeMs: 5000, successRate: 1 },
  }
  root = mount()
  await flush()
  const text = textOf(root)
  assert.match(text, /demo/)
  assert.match(text, /就绪/)
  assert.match(text, /HTTP_AUTH/)
  assert.match(text, /尚未成功连接/)
  assert.match(text, /最近成功/)
  assert.equal(calls.filter((call) => call.action === 'state').length, 0)
})

await check('点击「添加服务器」打开表单', async () => {
  const button = byText(root, '添加服务器')
  assert.ok(button, 'add button present')
  button.props.onClick()
  await flush()
  const text = textOf(root)
  assert.match(text, /编辑服务器|添加服务器/)
  assert.ok(byLabel(root, '服务器名（工具命名空间）'), 'server name field')
  assert.ok(byLabel(root, '命令'), 'command field')
})

await check('草稿测试连接返回结构化失败', async () => {
  const nameInput = byLabel(root, '服务器名（工具命名空间）')
  nameInput.props.onChange({ target: { value: 'probe' } })
  const commandInput = byLabel(root, '命令')
  commandInput.props.onChange({ target: { value: 'nope' } })
  rerender()
  // The row actions also say "测试连接"; scope the click to the editor panel.
  const editorPanel = findAll(root, (node) => node.props?.className === 'mc-panel' && node.props?.['aria-label'] === '添加服务器')[0]
  assert.ok(editorPanel, 'editor panel')
  const testButton = byText(editorPanel, '测试连接')
  testButton.props.onClick()
  await flush()
  const text = textOf(root)
  assert.match(text, /连接失败/)
  assert.match(text, /COMMAND_NOT_FOUND/)
  assert.match(text, /config/)
})

await check('保存调用 addServer 并展示挂载回执', async () => {
  const save = byText(root, '保存')
  save.props.onClick()
  await flush()
  const call = calls.find((item) => item.action === 'addServer')
  assert.ok(call, 'addServer called')
  assert.equal(call.payload.serverName, 'probe')
  assert.equal(call.payload.config.command, 'nope')
  const text = textOf(root)
  assert.match(text, /已添加服务器/)
  assert.match(text, /mcp__probe__echo|echo/)
})

await check('鉴权行：头名只读、令牌掩码、绑定为凭据引用', async () => {
  // Open a fresh add editor and switch it to Streamable HTTP.
  byText(root, '添加服务器').props.onClick()
  await flush()
  const transport = byLabel(root, '传输方式')
  transport.props.onChange({ target: { value: 'streamable-http' } })
  rerender()
  byLabel(root, '服务器名（工具命名空间）').props.onChange({ target: { value: 'modao' } })
  byLabel(root, '端点地址').props.onChange({ target: { value: 'https://modao.cc/agent-py/ai/mcp' } })
  rerender()

  // Left side is a fixed library, not free text.
  const headerSelect = findAll(root, (node) => node.type === 'select' && node.props?.['aria-label'] === '请求头')[0]
  assert.ok(headerSelect, 'auth header select')
  assert.equal(headerSelect.props.value, 'modao-token')
  const options = findAll(headerSelect, (node) => node.type === 'option').map((node) => node.props.children)
  assert.deepEqual(options, ['modao-token', 'Authorization', 'X-Api-Key', 'X-Auth-Token'])
  assert.equal(findAll(root, (node) => node.type === 'input' && node.props?.['aria-label'] === '请求头').length, 0)

  // Right side is a masked input by default, with an explicit reveal toggle.
  let tokenInput = findAll(root, (node) => node.type === 'input' && node.props?.['aria-label'] === '令牌')[0]
  assert.ok(tokenInput, 'token input')
  assert.equal(tokenInput.props.type, 'password')
  tokenInput.props.onChange({ target: { value: 'sekret-token' } })
  rerender()
  byText(root, '显示').props.onClick()
  rerender()
  tokenInput = findAll(root, (node) => node.type === 'input' && node.props?.['aria-label'] === '令牌')[0]
  assert.equal(tokenInput.props.type, 'text')

  // Binding writes the credential and leaves only a reference in the draft.
  byText(root, '存入凭据并绑定').props.onClick()
  await flush()
  const call = calls.filter((item) => item.action === 'setCredential').at(-1)
  assert.ok(call, 'setCredential called')
  assert.equal(call.payload.ref, 'MCP_MODAO_MODAO_TOKEN')
  assert.equal(call.payload.value, 'sekret-token')
  const text = textOf(root)
  assert.match(text, /\$\{credential:MCP_MODAO_MODAO_TOKEN\}/)
  // After binding the input is gone: the value lives only in the credential store.
  assert.equal(findAll(root, (node) => node.type === 'input' && node.props?.['aria-label'] === '令牌').length, 0)
  assert.match(text, /已绑定 MCP_MODAO_MODAO_TOKEN|已存入凭据库/)

  // Close the editor so later scenarios start from the list.
  const editorPanel = findAll(root, (node) => node.props?.className === 'mc-panel' && node.props?.['aria-label'] === '添加服务器')[0]
  byText(editorPanel, '取消').props.onClick()
  await flush()
})

await check('每台 MCP 只有一个鉴权头，其他请求头默认收起', async () => {
  // A fresh mount: the mini runtime keeps hook state per path, so reopening an
  // editor at the same path would otherwise inherit the previous draft.
  root = mount()
  await flush()
  byText(root, '添加服务器').props.onClick()
  await flush()
  byLabel(root, '传输方式').props.onChange({ target: { value: 'streamable-http' } })
  rerender()
  byLabel(root, '服务器名（工具命名空间）').props.onChange({ target: { value: 'single' } })
  byLabel(root, '端点地址').props.onChange({ target: { value: 'https://example.com/mcp' } })
  rerender()

  // Exactly one header input: the token field. No free-form headers editor.
  const tokenFields = findAll(root, (node) => node.type === 'input' && node.props?.['aria-label'] === '令牌')
  assert.equal(tokenFields.length, 1)
  assert.equal(findAll(root, (node) => node.type === 'textarea' && node.props?.['aria-label'] === '其他请求头').length, 0)

  // The advanced toggle reports zero extras and reveals the editor on demand.
  const toggle = byText(root, '高级：其他请求头（0）')
  assert.ok(toggle, 'advanced toggle')
  assert.equal(toggle.props['aria-expanded'], 'false')
  toggle.props.onClick()
  rerender()
  const area = findAll(root, (node) => node.type === 'textarea' && node.props?.['aria-label'] === '其他请求头')[0]
  assert.ok(area, 'advanced headers editor')
  area.props.onChange({ target: { value: 'X-Tenant: acme' } })
  rerender()
  // While open the toggle reads "hide"; collapsing reports the extra header count.
  byText(root, '收起其他请求头').props.onClick()
  rerender()
  assert.match(textOf(root), /高级：其他请求头（1）/)

  const editorPanel = findAll(root, (node) => node.props?.className === 'mc-panel' && node.props?.['aria-label'] === '添加服务器')[0]
  byText(editorPanel, '取消').props.onClick()
  await flush()
})

await check('列表行动作：禁用 / 重试 / 测试 / 删除二次确认', async () => {
  root = mount()
  await flush()
  const disable = byText(root, '禁用')
  assert.ok(disable, 'disable button')
  disable.props.onClick()
  await flush()
  assert.ok(calls.some((item) => item.action === 'setDisabled' && item.payload.disabled === true))

  const test = byText(root, '测试连接')
  test.props.onClick()
  await flush()
  assert.ok(calls.some((item) => item.action === 'testConnection' && item.payload.id === 'srv-new'))
  assert.match(textOf(root), /连接有效|2025-06-18/)

  const remove = byText(root, '删除')
  remove.props.onClick()
  await flush()
  assert.match(textOf(root), /确认删除/)
  const confirm = byText(root, '确认删除')
  confirm.props.onClick()
  await flush()
  assert.ok(calls.some((item) => item.action === 'removeServer'))
  assert.match(textOf(root), /已删除/)
})

await check('导入面板：逐条校验失败原样展示', async () => {
  const importButton = byText(root, '导入 JSON')
  importButton.props.onClick()
  await flush()
  const area = byPlaceholder(root, '{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}}')
  if (!area) console.log('DEBUG import text:', textOf(root).slice(-400))
  assert.ok(area, 'import textarea')
  area.props.onChange({ target: { value: '{"mcpServers": {"bad name!": {"command": "x"}}}' } })
  rerender()
  const run = byText(root, '校验并导入')
  if (!run) {
    const hits = findAll(root, (node) => textOf(node).trim() === '校验并导入')
    console.log('DEBUG matches:', hits.map((node) => JSON.stringify({ type: String(node.type), text: node.text, kids: (node.children ?? []).map((child) => child.type), onClick: typeof node.props?.onClick }).slice(0, 220)).join('\n'))
  }
  run.props.onClick()
  await flush()
  const text = textOf(root)
  assert.match(text, /1 条未通过校验/)
  assert.match(text, /SERVER_NAME_INVALID/)
  assert.match(text, /bad name!/)
})

await check('导出面板生成所选结构', async () => {
  const exportButton = byText(root, '导出 JSON')
  exportButton.props.onClick()
  await flush()
  const generate = byText(root, '生成')
  generate.props.onClick()
  await flush()
  const call = calls.find((item) => item.action === 'exportJson')
  assert.ok(call)
  assert.equal(call.payload.format, 'mcpServers')
  const area = findAll(root, (node) => node.type === 'textarea' && node.props?.readOnly === true)[0]
  assert.ok(area, 'export textarea')
  assert.match(area.props.value, /mcpServers/)
})

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  if (!item.ok) console.log(`      ${item.error?.stack?.split('\n').slice(0, 5).join('\n      ')}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
