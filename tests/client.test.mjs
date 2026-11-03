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

/** Find an operable node by its accessibility label (icon buttons have no text). */
function byAria(tree, label) {
  return findAll(tree, (node) => node.props?.['aria-label'] === label && typeof node.props?.onClick === 'function')[0]
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
  oauthBegin() {
    return { url: 'http://127.0.0.1:9876/authorize?state=abc', redirectUri: 'http://127.0.0.1:9877/callback' }
  },
  oauthRevoke() {
    return { receipt: { action: 'oauthRevoke', message: '已取消授权' } }
  },
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

let loads = 0

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
  loads += 1
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
  // One summary line replaces the old stats grid + policy block.
  assert.match(text, /0 台服务器 · 0 就绪 · 0 个工具/)
  assert.ok(!text.includes('部署策略'), 'policy block removed')
})

await check('列表展示状态徽标、最近成功与错误摘要', async () => {
  snapshot = {
    ...snapshot,
    servers: [
      {
        id: 'a1',
        serverName: 'demo',
        notes: ['服务器未下发 Mcp-Session-Id（会话无状态运行）'],
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
  assert.match(text, /1 个工具/)
  assert.match(text, /HTTP_AUTH/)
  assert.equal(calls.filter((call) => call.action === 'state').length, 0)
  // Connection warnings stay out of the card; they are noise for the operator.
  assert.ok(!text.includes('Mcp-Session-Id'), 'session note hidden')

  // Last-success lives in the details now, keeping the row to one meta line.
  const disclosure = findAll(root, (node) => node.props?.className === 'mc-disclosure')[0]
  assert.ok(disclosure, 'row disclosure')
  disclosure.props.onClick()
  rerender()
  assert.match(textOf(root), /最近成功/)
  assert.match(textOf(root), /调用 3（失败 0）/)
})

await check('添加弹窗：标题、表单/JSON 标签与基础字段', async () => {
  root = mount()
  await flush()
  byText(root, '添加 MCP').props.onClick()
  await flush()
  const dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  assert.ok(dialog, 'editor panel rendered')
  // Inline panel, not a modal: no dialog role and no aria-modal.
  assert.equal(dialog.props.role, undefined)
  assert.equal(dialog.props['aria-modal'], undefined)
  assert.match(textOf(dialog), /添加自定义 MCP/)
  assert.ok(byText(dialog, '表单'), 'form tab')
  assert.ok(byText(dialog, 'JSON'), 'json tab')
  assert.ok(byLabel(dialog, '服务器名（工具命名空间）'), 'name field')
  assert.ok(byAria(dialog, '传输类型'), 'transport picker')
  assert.ok(byLabel(dialog, '超时时间（毫秒，可选）'), 'timeout field')
  assert.ok(byLabel(dialog, '服务地址'), 'url field (HTTP is the default)')
  assert.ok(byText(dialog, '添加 MCP'), 'primary action')
  assert.ok(byText(dialog, '取消'), 'cancel action')
})

await check('传输类型是自绘下拉，选择后收起并切换字段', async () => {
  const panel = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  const trigger = byAria(panel, '传输类型')
  assert.ok(trigger, 'picker trigger')
  assert.equal(trigger.props['aria-expanded'], 'false')
  trigger.props.onClick()
  rerender()
  const menu = findAll(root, (node) => node.props?.['role'] === 'listbox')[0]
  assert.ok(menu, 'listbox open')
  const options = findAll(menu, (node) => node.props?.['role'] === 'option')
  assert.ok(options.length >= 2, 'options listed')
  assert.ok(options.every((option) => option.type === 'li'), 'options are list items, not native <option>')
  options.find((option) => textOf(option).includes('Streamable HTTP')).props.onClick()
  rerender()
  assert.equal(findAll(root, (node) => node.props?.['role'] === 'listbox').length, 0, 'menu closes after choosing')
  const after = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  assert.match(textOf(after), /服务地址/, 'HTTP fields appear')
})

await check('草稿测试连接返回结构化失败', async () => {
  let dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  // The previous case switched the draft to HTTP; go back to stdio.
  if (!findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === '命令').length) {
    byAria(dialog, '传输类型').props.onClick()
    rerender()
    byText(findAll(root, (node) => node.props?.['role'] === 'listbox')[0], 'stdio（本地子进程）').props.onClick()
    rerender()
    dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  }
  byLabel(dialog, '服务器名（工具命名空间）').props.onChange({ target: { value: 'probe' } })
  byLabel(dialog, '命令').props.onChange({ target: { value: 'nope' } })
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byText(dialog, '测试连接').props.onClick()
  await flush()
  const text = textOf(findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0])
  assert.match(text, /连接失败/)
  assert.match(text, /COMMAND_NOT_FOUND/)
  assert.match(text, /config/)
})

await check('请求头行：新增、默认隐藏、可显示、可删除', async () => {
  let dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byAria(dialog, '传输类型').props.onClick()
  rerender()
  byText(findAll(root, (node) => node.props?.['role'] === 'listbox')[0], 'Streamable HTTP').props.onClick()
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byLabel(dialog, '服务地址').props.onChange({ target: { value: 'https://example.com/mcp' } })
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  // No long hint and no credential affordance on the rows.
  assert.ok(!textOf(dialog).includes('存为凭据'), 'credential action removed')
  assert.ok(!textOf(dialog).includes('还没有请求头'), 'empty-state hint removed')

  byText(dialog, '+ 添加 Header').props.onClick()
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  const nameInput = findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === 'Header 名称')[0]
  assert.ok(nameInput, 'header name input')

  nameInput.props.onChange({ target: { value: 'modao-token' } })
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  let valueInput = findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === '值')[0]
  assert.equal(valueInput.props.type, 'password', 'value hidden by default')
  valueInput.props.onChange({ target: { value: 'sekret-token' } })
  rerender()

  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byAria(dialog, '显示值').props.onClick()
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  valueInput = findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === '值')[0]
  assert.equal(valueInput.props.type, 'text', 'eye reveals the full value')
  assert.equal(valueInput.props.value, 'sekret-token')

  byAria(dialog, '隐藏值').props.onClick()
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  assert.equal(findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === '值')[0].props.type, 'password')

  byAria(dialog, '删除该请求头').props.onClick()
  rerender()
})

await check('JSON 标签：合法内容回写表单，非法给出提示', async () => {
  let dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byText(dialog, 'JSON').props.onClick()
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  const area = findAll(dialog, (node) => node.type === 'textarea' && node.props?.['aria-label'] === 'JSON')[0]
  assert.ok(area, 'json textarea')
  area.props.onChange({
    target: { value: JSON.stringify({ mymcp: { transport: 'stdio', command: 'node', args: ['x'] } }, null, 2) },
  })
  rerender()
  byText(findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0], '表单').props.onClick()
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  const nameField = findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === '服务器名（工具命名空间）')[0]
  assert.equal(nameField.props.value, 'mymcp')
  assert.equal(findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === '命令')[0].props.value, 'node')

  byText(dialog, 'JSON').props.onClick()
  rerender()
  findAll(root, (node) => node.type === 'textarea' && node.props?.['aria-label'] === 'JSON')[0]
    .props.onChange({ target: { value: '{oops' } })
  rerender()
  assert.match(textOf(findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]), /JSON 不合法/)
  // Invalid JSON keeps the tab open on purpose; close the sheet for the next case.
  byText(findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0], '取消').props.onClick()
  await flush()
})

await check('添加 MCP 调用 addServer 并展示挂载回执', async () => {
  // Fresh mount: the mini runtime keeps hook state per path, so a dialog reopened
  // at the same path would otherwise inherit the previous tab and draft.
  root = mount()
  await flush()
  byText(root, '添加 MCP').props.onClick()
  await flush()
  let dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byAria(dialog, '传输类型').props.onClick()
  rerender()
  byText(findAll(root, (node) => node.props?.['role'] === 'listbox')[0], 'stdio（本地子进程）').props.onClick()
  rerender()
  dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byLabel(dialog, '服务器名（工具命名空间）').props.onChange({ target: { value: 'probe' } })
  byLabel(dialog, '命令').props.onChange({ target: { value: 'node' } })
  rerender()
  byText(findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0], '添加 MCP').props.onClick()
  await flush()
  const call = calls.filter((item) => item.action === 'addServer').at(-1)
  assert.ok(call, 'addServer called')
  assert.equal(call.payload.config.command, 'node')
  assert.equal(call.payload.disabled, false, 'saving always enables')
  assert.ok(!textOf(root).includes('保存后禁用'), 'no disabled switch in the dialog')
  assert.match(textOf(root), /已添加服务器/)
})

await check('列表行动作：禁用 / 重试 / 测试 / 删除二次确认', async () => {
  root = mount()
  await flush()

  // Per-card actions are icon buttons; the tooltip (title) carries the name.
  const rowList = () => findAll(root, (node) => node.props?.className === 'mc-list')[0]
  const card = () => findAll(rowList(), (node) => node.props?.className === 'mc-item')[0]
  for (const label of ['测试连接', '重试连接', '禁用', '编辑', '删除']) {
    const button = byAria(card(), label)
    assert.ok(button, `${label} icon present`)
    // DSH-style bubble owned by the page, not the OS title tooltip.
    assert.equal(button.props.title, undefined, `${label} has no native title`)
    const tip = findAll(card(), (node) => node.props?.className === 'mc-tip' && textOf(node) === label)[0]
    assert.ok(tip, `${label} tooltip bubble`)
    assert.equal(tip.props.role, 'tooltip')
  }
  const probeCard = () => findAll(rowList(), (node) => node.props?.className === 'mc-item' && textOf(node).includes('probe'))[0]
  const disable = byAria(card(), '禁用')
  disable.props.onClick()
  await flush()
  assert.ok(calls.some((item) => item.action === 'setDisabled' && item.payload.disabled === true))
  // The receipt lands on the card that produced it.
  assert.match(textOf(card()), /已禁用：连接断开，配置保留/, 'card shows its own receipt')

  const test = byAria(probeCard(), '测试连接')
  test.props.onClick()
  await flush()
  assert.ok(calls.some((item) => item.action === 'testConnection' && item.payload.id === 'srv-new'))
  assert.match(textOf(root), /连接有效|2025-06-18/)

  // Delete asks for confirmation with check / cancel icons.
  byAria(probeCard(), '删除').props.onClick()
  rerender()
  assert.ok(byAria(probeCard(), '确认删除'), 'confirm icon')
  byAria(probeCard(), '确认删除').props.onClick()
  await flush()
  assert.ok(calls.some((item) => item.action === 'removeServer'))
  assert.match(textOf(root), /已删除/)
})

await check('搜索过滤与无结果态，图标为矢量而非 emoji', async () => {
  root = mount()
  await flush()
  assert.ok(findAll(root, (node) => node.type === 'svg').length > 0, 'vector icons rendered')
  assert.ok(!textOf(root).includes('🔑'), 'no emoji as structural icon')

  const search = findAll(root, (node) => node.props?.['aria-label'] === '搜索服务器')[0]
  assert.equal(search.props.type, 'text', 'plain text input: no native clear button')
  assert.ok(search, 'search input')
  search.props.onChange({ target: { value: 'broken' } })
  rerender()
  const list = findAll(root, (node) => node.props?.className === 'mc-list')[0]
  assert.match(textOf(list), /broken/)
  assert.ok(!textOf(list).includes('demo'), 'non-matching row hidden')

  // Name-only matching: a substring that exists in the endpoint but not in any
  // server name must not match (this is what made "m" hit every server).
  search.props.onChange({ target: { value: 'https' } })
  rerender()
  assert.match(textOf(root), /没有匹配/, 'endpoint text is not searched')

  search.props.onChange({ target: { value: 'nothing-matches' } })
  rerender()
  assert.match(textOf(root), /没有匹配/)
  byText(root, '清除搜索').props.onClick()
  rerender()
  assert.equal(findAll(root, (node) => node.props?.['aria-label'] === '搜索服务器')[0].props.value, '')
})

await check('编辑弹窗与添加弹窗同构：标题、名称锁定、动作顺序', async () => {
  root = mount()
  await flush()
  const list = findAll(root, (node) => node.props?.className === 'mc-list')[0]
  byAria(list, '编辑').props.onClick()
  await flush()
  const dialog = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  assert.ok(dialog, 'edit dialog')
  assert.equal(dialog.props['aria-label'], '编辑自定义 MCP')
  const text = textOf(dialog)
  assert.match(text, /编辑自定义 MCP/)
  assert.match(text, /MCP 名称和 serverName 保持不变/)
  assert.match(text, /Agent 将看到 serverName/)
  const nameField = findAll(dialog, (node) => node.type === 'input' && node.props?.['aria-label'] === '服务器名（工具命名空间）')[0]
  assert.equal(nameField.props.disabled, true, 'serverName is immutable while editing')
  assert.ok(text.indexOf('取消') < text.indexOf('保存 MCP'), 'primary action sits last')
  byText(dialog, '取消').props.onClick()
  await flush()
})

await check('编辑：名称有效时不再误报必填，测试连接直接发出', async () => {
  root = mount()
  await flush()
  const list = findAll(root, (node) => node.props?.className === 'mc-list')[0]
  byAria(list, '编辑').props.onClick()
  await flush()
  const panel = () => findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  const before = calls.length
  byText(panel(), '测试连接').props.onClick()
  await flush()
  const fresh = calls.slice(before)
  const probe = fresh.find((item) => item.action === 'testConnection')
  assert.ok(probe, 'probe was sent')
  assert.equal(probe.payload.serverName, 'demo')
  assert.ok(!textOf(panel()).includes('必填'), 'valid name is not reported as required')
})

await check('必填校验：空名称点击保存给出红框与小字提示', async () => {
  root = mount()
  await flush()
  const list = findAll(root, (node) => node.props?.className === 'mc-list')[0]
  const httpCard = findAll(list, (node) => node.props?.className === 'mc-item' && textOf(node).includes('broken'))[0]
  byAria(httpCard, '编辑').props.onClick()
  await flush()
  let panel = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  // Clear the URL to make a required field empty, then save.
  const urlField = findAll(panel, (node) => node.type === 'input' && node.props?.['aria-label'] === '服务地址')[0]
  urlField.props.onChange({ target: { value: '' } })
  rerender()
  panel = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  byText(panel, '保存 MCP').props.onClick()
  await flush()
  panel = findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  const after = findAll(panel, (node) => node.type === 'input' && node.props?.['aria-label'] === '服务地址')[0]
  assert.equal(after.props['aria-invalid'], 'true', 'invalid field is marked')
  assert.match(textOf(panel), /必填/, 'small required hint shown')
})

await check('JSON 标签：一键优化格式化、保存基于 JSON 文本、且有高亮层', async () => {
  root = mount()
  await flush()
  byText(root, '添加 MCP').props.onClick()
  await flush()
  const panelOf = () => findAll(root, (node) => node.props?.className === 'mc-panel mc-editor')[0]
  const areaOf = () => findAll(panelOf(), (node) => node.type === 'textarea' && node.props?.['aria-label'] === 'JSON')[0]

  byText(panelOf(), 'JSON').props.onClick()
  await flush()
  areaOf().props.onChange({ target: { value: '{"probe":{"command":"node","args":["x"]}}' } })
  rerender()

  // code colours are painted by a layer under the transparent textarea
  const layer = findAll(panelOf(), (node) => node.props?.className === 'mc-json-hl')[0]
  assert.ok(layer, 'highlight layer rendered')
  assert.ok(findAll(layer, (node) => String(node.props?.className ?? '').includes('mc-tok-key')).length > 0, 'keys coloured')

  byText(panelOf(), '一键优化').props.onClick()
  rerender()
  assert.match(areaOf().props.value, /\n {2}"probe"/, 'pretty-printed and wrapped with the server name')
  assert.match(textOf(panelOf()), /已整理为标准格式/, 'tidy-up confirms itself')

  // A second click on already-formatted text still reports, so the button never
  // looks dead.
  byText(panelOf(), '一键优化').props.onClick()
  rerender()
  assert.match(textOf(panelOf()), /已整理为标准格式/)

  byText(panelOf(), '添加 MCP').props.onClick()
  await flush()
  const call = calls.filter((item) => item.action === 'addServer').at(-1)
  assert.ok(call, 'save works from the JSON tab')
  assert.equal(call.payload.serverName, 'probe')
  assert.equal(call.payload.config.command, 'node')
})

await check('OAuth：卡片上的授权 / 取消授权按钮调用对应动作', async () => {
  snapshot = {
    ...snapshot,
    servers: snapshot.servers.map((item) => (item.serverName === 'broken' ? { ...item, toolCount: 2 } : item)),
  }
  root = mount()
  await flush()
  const listOf = () => findAll(root, (node) => node.props?.className === 'mc-list')[0]
  const httpCard = () => findAll(listOf(), (node) => node.props?.className === 'mc-item' && textOf(node).includes('broken'))[0]

  // The pill sits to the right of the tools tag.
  const cardText = textOf(httpCard())
  assert.ok(cardText.indexOf('2 个工具') >= 0, 'tools tag rendered')
  assert.ok(cardText.indexOf('2 个工具') < cardText.indexOf('授权'), 'authorize pill follows the tools tag')

  const authorize = byText(httpCard(), '授权')
  assert.ok(authorize, 'authorize tag button on http servers')
  authorize.props.onClick()
  await flush()
  const oauthCall = calls.find((item) => item.action === 'oauthBegin')
  assert.ok(oauthCall, 'oauthBegin called')
  assert.equal(typeof oauthCall.payload.id, 'string')
  assert.match(textOf(root), /等待浏览器完成授权/)

  snapshot = {
    ...snapshot,
    servers: snapshot.servers.map((item) => (item.id === oauthCall.payload.id
      ? { ...item, oauth: { status: 'authorized', authorized: true, expiresAt: null, error: null } }
      : item)),
  }
  root = mount()
  await flush()
  assert.ok(byText(httpCard(), '取消授权'), 'revoke tag button once authorized')
  assert.match(textOf(httpCard()), /已授权/)
  byText(httpCard(), '取消授权').props.onClick()
  await flush()
  assert.ok(calls.some((item) => item.action === 'oauthRevoke' && item.payload.id === oauthCall.payload.id))
})

await check('刷新按钮触发重新拉取并给出已刷新提示', async () => {
  root = mount()
  await flush()
  const before = loads
  const button = byAria(root, '刷新')
  assert.ok(button, 'refresh icon button')
  button.props.onClick()
  await flush()
  assert.ok(loads > before, 'refetch happened')
  assert.match(textOf(root), /已刷新/, 'confirmation shown')
})

const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
  if (!item.ok) console.log(`      ${item.error?.stack?.split('\n').slice(0, 5).join('\n      ')}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
