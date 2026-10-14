// Agent-hint wire observer: logs the agent_hint field of every data-plane
// (POST /v1/messages) and control-plane (POST /v1/chat/completions) request,
// then forwards to the real coordinator and streams the response back.
// Usage: node agent-hint-watch.mjs   (env: PORT=1026, UPSTREAM=http://127.0.0.1:1025, VERBOSE=1)
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:1025'
// 1026 is the port ~/.dsh/profiles/web/cordis.patch.yml points the agent-hint
// baseURL at; 3080 belongs to `dsh web` and collides with it.
const PORT = Number(process.env.PORT ?? 1026)
const VERBOSE = process.env.VERBOSE === '1'

const stamp = () => new Date().toISOString().slice(11, 19)
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'host'])

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    void (async () => {
      const body = Buffer.concat(chunks)
      const url = new URL(request.url ?? '/', 'http://localhost')
      const isData = request.method === 'POST' && url.pathname === '/v1/messages'
      const isControl = request.method === 'POST' && url.pathname === '/v1/chat/completions'
      if (isData || isControl) {
        try {
          const parsed = JSON.parse(body.toString('utf8'))
          const hint = parsed.agent_hint
          console.log(`[${stamp()}] ${isData ? 'DATA   ' : 'CONTROL'} POST ${url.pathname} stream=${parsed.stream ?? false} messages=${Array.isArray(parsed.messages) ? parsed.messages.length : '?'}`)
          console.log(`  agent_hint: ${hint === undefined ? '<absent>' : JSON.stringify(hint)}`)
          if (VERBOSE) console.log(`  body: ${body.toString('utf8')}`)
        } catch {
          console.log(`[${stamp()}] POST ${url.pathname} (unparseable body)`)
        }
      } else {
        console.log(`[${stamp()}] ${request.method} ${url.pathname}${url.search}`)
      }
      try {
        const headers = {}
        for (const [name, value] of Object.entries(request.headers)) {
          if (HOP_BY_HOP.has(name) || value === undefined) continue
          headers[name] = Array.isArray(value) ? value.join(', ') : value
        }
        const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
          // The coordinator may stall for minutes while scheduling; undici's
          // default 300s body/header timeouts would kill the relay.
          headersTimeout: 0,
          bodyTimeout: 0,
        })
        const responseHeaders = {}
        for (const [name, value] of upstream.headers.entries()) {
          if (HOP_BY_HOP.has(name)) continue
          responseHeaders[name] = value
        }
        response.writeHead(upstream.status, responseHeaders)
        if (upstream.body === null) response.end()
        else {
          const stream = Readable.fromWeb(upstream.body)
          // A stalled/aborted upstream must end the client response, never the process.
          stream.on('error', (error) => {
            console.log(`[${stamp()}] upstream stream error: ${String(error)}`)
            response.destroy(error instanceof Error ? error : undefined)
          })
          stream.pipe(response)
        }
      } catch (error) {
        console.log(`[${stamp()}] upstream error: ${String(error)}`)
        if (!response.headersSent) response.writeHead(502)
        response.end(String(error))
      }
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`agent-hint-watch: http://127.0.0.1:${PORT} -> ${UPSTREAM}`)
})
