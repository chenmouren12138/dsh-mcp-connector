/**
 * stdio transport: newline-delimited JSON-RPC over a child process.
 *
 * The transport owns the child: `send` writes one line to stdin, stdout lines are
 * decoded as JSON-RPC frames, and stderr is captured in a bounded ring buffer for
 * diagnostics. `close()` terminates the child and waits for the exit fact, so the
 * plugin's disposer chain never leaves a stray server process behind.
 *
 * Why `node:child_process` rather than `ctx.subprocess`: the subprocess seam's own
 * contract says transports that own their spawn (SDK clients, MCP) bypass it —
 * env scrubbing stays the single source of truth because this module applies the
 * same rule (drop credential-shaped and `DSH_*` names, then merge declared `env`).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CODES, McpDiagnostic, PHASES, redactText } from './diagnostics.js'

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const DEFAULT_GRACE_MS = 2000
const CREDENTIAL_NAME = /(token|secret|api[-_]?key|passw|credential|cookie|authorization)/i

/**
 * Parent environment minus credentials and `DSH_*` deployment facts.
 * Mirrors `scrubbedParentEnv` from the subprocess seam without importing it.
 */
export function scrubbedEnv(extra = {}) {
  const output = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('DSH_') || CREDENTIAL_NAME.test(key)) continue
    output[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue
    output[key] = String(value)
  }
  return output
}

/**
 * Resolve a command to an absolute executable, honouring `PATHEXT` on Windows.
 *
 * @param command - the user-declared `command` (absolute path or bare name).
 * @param cwd - resolution base for relative paths.
 * @returns the absolute executable path.
 * @throws McpDiagnostic COMMAND_NOT_FOUND / COMMAND_NOT_EXECUTABLE.
 */
export function resolveExecutable(command, cwd) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new McpDiagnostic(CODES.COMMAND_MISSING, PHASES.config, 'stdio 服务器必须填写 command')
  }
  const raw = command.trim().replace(/^"(.*)"$/, '$1')
  const isWindows = process.platform === 'win32'
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())
    : ['']
  const candidates = []
  const isAbsolute = path.isAbsolute(raw)
  const bases = isAbsolute || raw.includes('/') || raw.includes('\\')
    ? [path.resolve(cwd || process.cwd(), raw)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, raw))

  for (const base of bases) {
    if (path.extname(base) === '') {
      if (isWindows) for (const ext of exts) candidates.push(base + ext)
      else candidates.push(base)
    } else {
      candidates.push(base)
    }
  }
  for (const candidate of candidates) {
    let stats
    try {
      stats = fs.statSync(candidate)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    if (!isWindows) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
      } catch {
        throw new McpDiagnostic(CODES.COMMAND_NOT_EXECUTABLE, PHASES.config, `command 不可执行：${candidate}`, { command: raw })
      }
    }
    return candidate
  }
  throw new McpDiagnostic(CODES.COMMAND_NOT_FOUND, PHASES.config, `找不到可执行文件：${raw}`, {
    command: raw,
    searchedPath: isAbsolute ? undefined : (process.env.PATH ?? '').split(path.delimiter).slice(0, 8),
  })
}

/** Windows `.cmd`/`.bat` shims must run through `cmd.exe`, not CreateProcess directly. */
function needsShellShim(executable) {
  if (process.platform !== 'win32') return false
  const ext = path.extname(executable).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

/**
 * A live stdio MCP transport.
 *
 * Callbacks (`onmessage`, `onclose`, `onstderr`) are assigned by the connection
 * before `start()`; frames that arrive earlier are buffered.
 */
export class StdioTransport {
  #child = null
  #buffer = ''
  #stderr = []
  #closing = false
  #closed = false
  #exit = null
  #started = false

  /**
   * @param options.command - executable (bare name or path).
   * @param options.args - argv tail.
   * @param options.env - declared environment overrides.
   * @param options.cwd - working directory (validated by the caller).
   * @param options.maxStderrLines - ring buffer size.
   * @param options.graceMs - time between SIGTERM and SIGKILL.
   */
  constructor({ command, args = [], env = {}, cwd = '', maxStderrLines = 40, graceMs = DEFAULT_GRACE_MS }) {
    this.command = command
    this.args = Array.isArray(args) ? args.map(String) : []
    this.env = env
    this.cwd = cwd
    this.maxStderrLines = maxStderrLines
    this.graceMs = graceMs
    this.onmessage = null
    this.onclose = null
    this.onstderr = null
    this.pending = []
  }

  /** Transport identity for diagnostics. */
  describe() {
    const executable = this.executable ?? this.command
    return { type: 'stdio', command: executable, args: this.args, cwd: this.cwd || process.cwd() }
  }

  /** The captured stderr tail (already redacted). */
  stderrTail(count = this.maxStderrLines) {
    return this.#stderr.slice(-count)
  }

  /**
   * Validate the command, then spawn the child.
   * @throws McpDiagnostic COMMAND_NOT_FOUND / COMMAND_NOT_EXECUTABLE / SPAWN_FAILED.
   */
  async start() {
    if (this.cwd) {
      let stats
      try {
        stats = fs.statSync(this.cwd)
      } catch {
        throw new McpDiagnostic(CODES.CWD_MISSING, PHASES.config, `工作目录不存在：${this.cwd}`, { cwd: this.cwd })
      }
      if (!stats.isDirectory()) {
        throw new McpDiagnostic(CODES.CWD_MISSING, PHASES.config, `工作目录不是目录：${this.cwd}`, { cwd: this.cwd })
      }
    }
    const executable = resolveExecutable(this.command, this.cwd)
    this.executable = executable
    const shim = needsShellShim(executable)
    const shimLine = `"${executable}" ${this.args.map(quoteCmd).join(' ')}`.trim()
    const child = shim
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${shimLine}"`], {
        windowsVerbatimArguments: true,
        cwd: this.cwd || undefined,
        env: scrubbedEnv(this.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      : spawn(executable, this.args, {
        cwd: this.cwd || undefined,
        env: scrubbedEnv(this.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    this.#child = child
    this.#started = true

    child.on('error', (error) => {
      const code = error?.code === 'ENOENT'
        ? CODES.COMMAND_NOT_FOUND
        : error?.code === 'EACCES'
          ? CODES.COMMAND_NOT_EXECUTABLE
          : CODES.SPAWN_FAILED
      this.#emitClose(new McpDiagnostic(code, PHASES.transport, `子进程启动失败：${error?.message ?? error}`, {
        command: executable,
        errno: error?.code,
      }))
    })
    child.on('exit', (code, signal) => {
      this.#exit = { code, signal }
      if (!this.#closing) {
        this.#emitClose(new McpDiagnostic(CODES.PROCESS_EXITED, PHASES.transport, `子进程已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`, {
          exitCode: code,
          signal,
          stderr: this.stderrTail(),
        }))
      }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line === '') continue
        this.#stderr.push(redactText(line))
        if (this.#stderr.length > this.maxStderrLines * 4) this.#stderr.splice(0, this.#stderr.length - this.maxStderrLines)
        this.onstderr?.(this.#stderr.at(-1))
      }
    })
    child.stdin.on('error', () => {
      // EPIPE after the child died is reported through the exit path instead.
    })
    return this.describe()
  }

  /**
   * Write one JSON-RPC message as a single line.
   * @param message - the message object.
   */
  send(message) {
    if (!this.#child || this.#closed) {
      throw new McpDiagnostic(CODES.TRANSPORT_CLOSED, PHASES.transport, 'stdio 传输已关闭')
    }
    const line = `${JSON.stringify(message)}\n`
    this.#child.stdin.write(line, 'utf8')
  }

  /**
   * Terminate the child and wait for its exit fact.
   * @returns settlement once the process is gone (or after the kill grace).
   */
  async close() {
    if (this.#closed) return this.#exit
    this.#closing = true
    const child = this.#child
    if (!child || child.exitCode !== null) {
      this.#closed = true
      return this.#exit
    }
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      child.stdin.end()
    } catch {
      // stdin may already be gone.
    }
    child.kill('SIGTERM')
    const settled = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), this.graceMs)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
    if (!settled) {
      child.kill('SIGKILL')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))])
    }
    this.#closed = true
    return this.#exit
  }

  #consume(chunk) {
    this.#buffer += chunk
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.#buffer = ''
      this.#emitClose(new McpDiagnostic(CODES.INVALID_FRAME, PHASES.transport, 'stdout 单帧超过 8MB，疑似不是 JSON-RPC 服务', {}))
      return
    }
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line !== '') this.#frame(line)
      newline = this.#buffer.indexOf('\n')
    }
  }

  #frame(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // Some servers print banners to stdout; keep reading but report once the
      // line clearly looks like JSON (starts with `{`).
      const looksLikeJson = line.startsWith('{') || line.startsWith('[')
      if (looksLikeJson) {
        this.#emitClose(new McpDiagnostic(CODES.INVALID_FRAME, PHASES.transport, 'stdout 输出不符合 JSON-RPC 帧格式', {
          sample: redactText(line.slice(0, 400)),
        }))
      }
      return
    }
    this.onmessage?.(message)
  }

  #emitClose(diagnostic) {
    if (this.#closed) return
    this.#closed = true
    this.onclose?.(diagnostic)
  }
}

/** Quote one argv element for a `cmd.exe /c` command line. */
function quoteCmd(value) {
  const text = String(value)
  if (text === '') return '""'
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}
