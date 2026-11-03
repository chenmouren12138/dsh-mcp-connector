// Minimal MCP stdio server used by the connector's host tests.
// Speaks newline-delimited JSON-RPC 2.0: initialize, tools/list, tools/call.
import process from 'node:process'

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: '两数相加',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'fail',
    description: '总是返回业务错误',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'weird name!',
    description: '名字含非法字符，用于验证公共名归一化',
    inputSchema: { type: 'object', properties: {} },
  },
]

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (line === '') continue
    handle(JSON.parse(line))
  }
})

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  if (message.id === undefined) return
  const { id, method, params } = message
  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion === '2026-06-18' ? '2025-06-18' : (params?.protocolVersion ?? '2025-06-18'),
            capabilities: { tools: { listChanged: true }, resources: {} },
            serverInfo: { name: 'echo-server', version: '0.1.0' },
            instructions: '测试服务器：echo / add / fail',
          },
        })
        return
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
        return
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (name === 'echo') {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] } })
          return
        }
        if (name === 'add') {
          const sum = Number(args.a) + Number(args.b)
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: String(sum) }],
              structuredContent: { sum },
            },
          })
          return
        }
        if (name === 'fail') {
          send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '这是业务错误' }] } })
          return
        }
        if (name === 'weird name!') {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } })
          return
        }
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } })
        return
      }
      case 'nope':
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
        return
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } })
  }
}

// A line of noise on stderr, including a token that must be redacted on display.
process.stderr.write('echo-server ready; Authorization: Bearer sk-test-1234567890abcdef\n')
