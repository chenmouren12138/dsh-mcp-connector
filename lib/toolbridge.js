/**
 * Tool bridge: map a server's tools onto the harness ToolRuntime.
 *
 * Naming is the contract agents see, so it mirrors the official
 * `@deepseek-ai/dsh-mcp-client` algorithm exactly: `mcp__<serverName>__<rawName>`,
 * normalized to the model's function-name grammar, and — when normalization or
 * truncation actually changes the name — suffixed with a short hash of the
 * `(serverName, rawName)` identity so two distinct tools never collapse into one.
 *
 * Registration is effect-scoped by the caller: `registerServerTools` returns the
 * disposers it created, and the runtime disposes them in reverse order on
 * unload, edit or disconnect.
 */
import { createHash } from 'node:crypto'
import { CODES, McpDiagnostic, PHASES } from './diagnostics.js'

/** DeepSeek function-name contract. */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/**
 * Derive the model-facing public name for one MCP tool.
 * @param serverName - the server namespace (already validated).
 * @param rawName - the tool name as the server declared it.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Join MCP content blocks into one text projection. */
export function projectText(content, toolName) {
  const blocks = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      blocks.push('[不支持的 MCP 内容块：需要对象]')
      continue
    }
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') blocks.push(block.text)
        break
      case 'image':
        blocks.push(`[图片结果：${block.mimeType ?? '未知类型'}；原始数据保留给程序化调用方]`)
        break
      case 'audio':
        blocks.push(`[音频结果：${block.mimeType ?? '未知类型'}；原始数据保留给程序化调用方]`)
        break
      case 'resource_link':
        blocks.push(block.name && block.uri ? `资源链接：${block.name}（${block.uri}）` : '[资源链接缺少 name 或 uri]')
        break
      case 'resource':
        blocks.push('[内嵌资源未展开；原始数据保留给程序化调用方]')
        break
      default:
        blocks.push(`[不支持的 MCP 内容类型：${String(block.type)}]`)
        break
    }
  }
  const text = blocks.join('\n').trim()
  return text === '' ? `（${toolName} 没有返回可见内容）` : text
}

/** Output schema: canonical content plus the server's optional structured result. */
function outputFor(structuredSchema) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        ...(structuredSchema === undefined ? {} : { structuredContent: structuredSchema }),
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: projectText(value?.content ?? [], 'tool') }]
    },
  }
}

/**
 * Build one ToolRuntime definition for an MCP tool.
 *
 * @param options.serverName - namespace.
 * @param options.tool - `{ name, description, inputSchema, outputSchema }`.
 * @param options.call - `(args, signal) => Promise<{content, structuredContent?}>`.
 * @param options.label - diagnostic prefix used in thrown messages.
 */
export function buildToolDefinition({ serverName, tool, call, label }) {
  const publicName = publicToolName(serverName, tool.name)
  return {
    name: publicName,
    description: describeTool(serverName, tool),
    parameters: normalizeInputSchema(tool.inputSchema),
    output: outputFor(tool.outputSchema),
    async execute(args, exec) {
      try {
        return await call(args ?? {}, exec?.signal)
      } catch (error) {
        const diagnostic = error instanceof McpDiagnostic
          ? error
          : new McpDiagnostic(CODES.TOOL_ERROR, PHASES.call, error?.message ?? String(error), {})
        const failure = new Error(`${label}: ${diagnostic.message}（${diagnostic.phase}/${diagnostic.code}）`)
        failure.code = diagnostic.code
        failure.phase = diagnostic.phase
        failure.diagnostic = diagnostic.toJSON()
        throw failure
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `MCP：${serverName} · ${tool.name}`,
      kind: 'other',
      ...(args && Object.keys(args).length > 0 ? { detail: summarizeArgs(args) } : {}),
    }),
  }
}

function describeTool(serverName, tool) {
  const description = tool.description?.trim()
  const suffix = `（来自 MCP 服务器 ${serverName}）`
  if (description === undefined || description === '') return `调用 MCP 工具 ${tool.name}${suffix}`
  return `${description}${description.endsWith('。') || description.endsWith('.') ? '' : '。'}${suffix}`
}

/** Keep a supported JSON Schema; anything unusable becomes an open object schema. */
function normalizeInputSchema(schema) {
  if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
    if (schema.type === 'object' || schema.properties !== undefined) return schema
  }
  return { type: 'object', additionalProperties: true }
}

function summarizeArgs(args) {
  const parts = []
  for (const [key, value] of Object.entries(args).slice(0, 4)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${key}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`)
  }
  return parts.join(', ')
}

/**
 * Register one server's tools on the harness tool registry.
 *
 * Two phases keep the swap safe, mirroring the official client: build the full
 * next generation first (so a duplicate raw name aborts before anything is
 * disposed), then dispose the previous generation and register the new one.
 *
 * @param ctx - Cordis context with `tools`.
 * @param options.serverName - namespace.
 * @param options.tools - discovered tools.
 * @param options.call - `(tool, args, signal) => Promise<result>`; receives the
 *   exact discovered tool so the raw wire name is never re-derived.
 * @param options.previous - disposers from the prior generation.
 * @returns `{ disposers, names, conflict }`.
 */
export function registerServerTools(ctx, { serverName, tools, call, previous = [], label }) {
  const definitions = []
  const seen = new Set()
  for (const tool of tools) {
    const publicName = publicToolName(serverName, tool.name)
    if (seen.has(publicName)) {
      return {
        disposers: previous,
        names: [],
        conflict: new McpDiagnostic(CODES.DUPLICATE_TOOL, PHASES.tools, `服务器 ${serverName} 重复声明了工具 ${tool.name}`, {
          tool: tool.name,
          publicName,
        }),
      }
    }
    seen.add(publicName)
    definitions.push(buildToolDefinition({
      serverName,
      tool,
      label,
      call: (args, signal) => call(tool, args, signal),
    }))
  }

  for (const dispose of [...previous].reverse()) {
    try {
      dispose()
    } catch {
      // A disposer that throws must not block the swap.
    }
  }

  const disposers = []
  const names = []
  try {
    for (const definition of definitions) {
      disposers.push(ctx.tools.register(definition))
      names.push(definition.name)
    }
  } catch (error) {
    for (const dispose of [...disposers].reverse()) {
      try {
        dispose()
      } catch {
        // roll back what we can
      }
    }
    return {
      disposers: [],
      names: [],
      conflict: new McpDiagnostic(CODES.DUPLICATE_TOOL, PHASES.tools, `工具注册失败：${error?.message ?? error}`, {
        serverName,
      }),
    }
  }
  return { disposers, names, conflict: undefined }
}

/** Dispose a generation in reverse registration order. */
export function disposeTools(disposers) {
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose()
    } catch {
      // best effort
    }
  }
}
