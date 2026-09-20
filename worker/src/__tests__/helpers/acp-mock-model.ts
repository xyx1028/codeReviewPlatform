import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface ScriptedToolCall {
  name: string
  args: unknown
}

/** A scripted turn may depend on what the conversation has revealed so far. */
export type ScriptedTurn = ScriptedToolCall | ((requestBody: string) => ScriptedToolCall)

/** Minimal OpenAI-compatible streaming endpoint with scripted turns. */
export function startMockModelServer(
  script: ScriptedTurn[],
  /** Failed requests do not consume the script. */
  transientServerFailures = 0,
): Promise<{
  baseUrl: string
  requestCount: () => number
  failedCount: () => number
  servedToolNames: () => string[]
  close: () => Promise<void>
}> {
  let requestCount = 0
  let failedCount = 0
  const servedToolNames: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      if (failedCount < transientServerFailures) {
        failedCount++
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('model endpoint unreachable from this Mac')
        return
      }
      const index = requestCount++
      const entry = script[Math.min(index, script.length - 1)]
      const requestBody = Buffer.concat(chunks).toString('utf8')
      let scripted: ScriptedToolCall
      try {
        scripted = typeof entry === 'function' ? entry(requestBody) : entry
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(error instanceof Error ? error.message : 'script callback failed')
        return
      }
      servedToolNames.push(scripted.name)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-${index}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'poc-model',
      }
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }

      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })
      send({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_${index}`,
              type: 'function',
              function: { name: scripted.name, arguments: JSON.stringify(scripted.args) },
            }],
          },
          finish_reason: null,
        }],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      send({
        ...base,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requestCount: () => requestCount,
        failedCount: () => failedCount,
        servedToolNames: () => [...servedToolNames],
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      })
    })
  })
}
