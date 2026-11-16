// 本地模拟 Cloudflare Pages 运行时，验证 functions/v1.js 的代理逻辑
// 用法：node test-pages.mjs
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const settings = JSON.parse(readFileSync(HERE + 'settings.json', 'utf8'))

// 把 Pages Function 当模块加载
const mod = await import(new URL('./pages/functions/v1.js', import.meta.url).href)

const PAGE = readFileSync(HERE + 'pages/public/index.html')

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  // 静态页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  // /v1/* 交给 function
  if (url.pathname.startsWith('/v1/')) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const request = new Request('http://127.0.0.1' + req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
    const env = { RELAY_KEY: settings.apiKey, RELAY_BASE: settings.baseUrl }
    try {
      const resp = await mod.onRequest({ request, env, next: () => new Response('nf', { status: 404 }) })
      const h = {}
      for (const [k, v] of resp.headers) h[k] = v
      res.writeHead(resp.status, h)
      if (resp.body) {
        // 流式透传，顺便数一下有几个 chunk
        const reader = resp.body.getReader()
        let first = true
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (first) { console.log('  first chunk arrived before body finished (streaming OK)'); first = false }
          res.write(value)
        }
        res.end()
      } else {
        res.end()
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('function threw: ' + e.message)
    }
    return
  }
  res.writeHead(404); res.end('not found')
})

await new Promise((r) => server.listen(8790, '127.0.0.1', r))
console.log('test server on http://127.0.0.1:8790')

const base = 'http://127.0.0.1:8790'

// 1) 预检
const pre = await fetch(base + '/v1/chat/completions', {
  method: 'OPTIONS',
  headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
})
console.log('1. preflight:', pre.status, '| ACAO:', pre.headers.get('access-control-allow-origin'))

// 2) ping
const ping = await fetch(base + '/v1/ping')
console.log('2. ping:', ping.status, await ping.text())

// 3) 真流式对话
const t0 = Date.now()
const chat = await fetch(base + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: '你是微信上回消息的人。只回一句很短的话，不超过15个字。' },
      { role: 'user', content: '今天有点累' },
    ],
    stream: true,
    max_tokens: 60,
  }),
})
console.log('3. chat:', chat.status, '| ACAO:', chat.headers.get('access-control-allow-origin'),
  '| type:', chat.headers.get('content-type'))
let text = ''
let chunks = 0
const reader = chat.body.getReader()
const dec = new TextDecoder()
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  chunks++
  for (const line of dec.decode(value, { stream: true }).split('\n')) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    const d = s.slice(5).trim()
    if (d === '[DONE]') continue
    try {
      const j = JSON.parse(d)
      const c = j.choices?.[0]?.delta?.content
      if (c) text += c
    } catch {}
  }
}
console.log('   reply:', JSON.stringify(text), '| chunks:', chunks, '| total ms:', Date.now() - t0)

server.close()
const ok = pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*' && chat.status === 200 && text.length > 0
console.log(ok ? '\nPASS' : '\nFAIL')
process.exit(ok ? 0 : 1)
